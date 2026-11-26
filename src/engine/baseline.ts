import {
  Agent,
  createAgent,
  createHuman,
  SemanticEvent,
  SituationSpecification,
  type SituationContext,
  type SituationHandler,
  type Tool,
} from "@mozaik-ai/core";
import { computeGroundedLedger } from "../finance/ledger.js";
import type { CaseRunReport, FinalVerdict, ScenarioFixture, SellerId } from "../finance/types.js";
import { resolveInferenceMode } from "../mozaik/runner.js";
import { createRefundGuardRuntime, RefundGuardState } from "../mozaik/runtime.js";

class WhenCaseOpened extends SituationSpecification {
  isSatisfiedBy({ event }: SituationContext): boolean {
    return event.type === "case.opened";
  }
}

class WhenModelAnswers extends SituationSpecification {
  isSatisfiedBy({ event }: SituationContext): boolean {
    return event.type === "model.answer";
  }
}

/**
 * Fair single-agent sequential baseline for comparison:
 * - Uses the EXACT SAME deterministic integer-KSh calculator and inference runner.
 * - Has ONLY ONE agent (RefundDeskAgent) operating on the t=0 ticket + draft snapshot,
 *   with NO concurrent DisputeFulfillmentSentinel and NO Mozaik InterceptionHandler.
 *
 * This demonstrates concretely why a single non-intercepted agent misses:
 * - Zero-sum wrong-seller draft errors hidden behind a balanced batch total,
 * - Missing warehouse receipt evidence (no independent fulfillment check),
 * - Mid-flight warehouse corrections (commits on stale epoch=1), and
 * - Mid-flight asynchronous bank chargeback webhooks (leaks KSh 10,000 double-payout).
 */
export async function runSingleAgentBaseline(
  scenario: ScenarioFixture,
  options?: { modeOverride?: "auto" | "live" | "mock"; latencyScale?: number },
): Promise<CaseRunReport> {
  const latencyScale = options?.latencyScale ?? 1;
  const resolved = resolveInferenceMode({
    modeOverride: options?.modeOverride,
    latencyScale,
  });

  const runtime = createRefundGuardRuntime();
  const state = new RefundGuardState(scenario, resolved.mode, resolved.modelName);

  runtime.initializeRuntime({
    state,
    inferenceRunnerConfig: resolved.inferenceRunnerConfig,
  });

  const coordinator = createHuman({
    name: "BaselineCoordinator",
    capabilities: [],
    handlers: [],
  });

  const proposeRefundTool: Tool = {
    type: "function",
    name: "propose_refund",
    description: "Approve refund deduction on the payout draft.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        checkoutId: { type: "string" },
        debitSellerId: { type: "string", enum: ["SELLER-A", "SELLER-B"] },
        refundAmountKsh: { type: "number" },
        epoch: { type: "number" },
        rationale: { type: "string" },
      },
      required: ["checkoutId", "debitSellerId", "refundAmountKsh", "epoch", "rationale"],
      additionalProperties: false,
    },
    invoke: async (args: {
      checkoutId: string;
      debitSellerId: SellerId;
      refundAmountKsh: number;
      epoch: number;
      rationale: string;
    }) => {
      state.acceptedProposal = {
        epoch: args.epoch,
        checkoutId: args.checkoutId,
        debitSellerId: args.debitSellerId,
        refundAmountKsh: scenario.draft.refundAmountKsh,
        rationale: args.rationale,
        citedSourceIds: [scenario.ticket.ticketId, scenario.draft.draftId],
      };
      state.verdict = "READY_FOR_HUMAN_APPROVAL";
      state.recordEvent(
        "proposal.accepted",
        "SingleBaselineAgent",
        `Baseline approved debit=${args.debitSellerId} KSh ${scenario.draft.refundAmountKsh.toLocaleString("en-KE")} without concurrent sentinel or interception.`,
      );
      return { accepted: true, debitSellerId: args.debitSellerId };
    },
  };

  const onOpened: SituationHandler = {
    specification: new WhenCaseOpened(),
    processor: {
      apply({ participant }) {
        if (!(participant instanceof Agent)) return;
        const prompt = [
          "Review this Black Friday customer refund ticket and payout draft, then call `propose_refund`.",
          `CHECKOUT_ID: ${scenario.checkoutId}`,
          `INITIAL_EPOCH: 1`,
          `REFUND_AMOUNT_KSH: ${scenario.draft.refundAmountKsh}`,
          "CUSTOMER_TICKET:",
          `${scenario.ticket.ticketId}: ${scenario.ticket.message}`,
          "PAYOUT_DRAFT:",
          `DRAFT_ID: ${scenario.draft.draftId}`,
          `DRAFT_DEBITED_SELLER: ${scenario.draft.debitedSellerId}`,
          `DRAFT_TOTAL_KSH: ${scenario.draft.totalBatchSettlementKsh}`,
        ].join("\n");

        state.refundDeskWindows.push({ startedAtMs: Date.now() });
        // Notice: NO InterceptionHandler and NO concurrent Sentinel!
        runtime.runLoop(participant.getId(), prompt, {
          model: state.modelName,
          context: participant.getMemory().getContext(),
          tools: participant.getTools(),
        });
      },
    },
  };

  const singleAgent = createAgent({
    name: "SingleBaselineAgent",
    capabilities: ["refund-policy"],
    instruction:
      "Review the customer refund ticket and payout draft, then call propose_refund.",
    tools: [proposeRefundTool],
    handlers: [onOpened],
  });

  const observer = createHuman({
    name: "BaselineObserver",
    capabilities: [],
    handlers: [
      {
        specification: new WhenModelAnswers(),
        processor: {
          apply({ event }) {
            if (event.producerId === singleAgent.getId()) {
              const w = state.refundDeskWindows[state.refundDeskWindows.length - 1];
              if (w) w.endedAtMs = Date.now();
              state.markRefundDeskFinished("READY_FOR_HUMAN_APPROVAL");
            }
          },
        },
      },
    ],
  });

  runtime.join(coordinator);
  runtime.join(singleAgent);
  runtime.join(observer);

  // Even when the exact same mid-flight event arrives in the background,
  // the single baseline agent has no concurrent sentinel or interception gate.
  let injectionTimer: ReturnType<typeof setTimeout> | undefined;
  if (scenario.midFlightInjection) {
    const inj = scenario.midFlightInjection;
    injectionTimer = setTimeout(() => {
      if (inj.kind === "WAREHOUSE_CORRECTION" && inj.warehouseNote) {
        state.addWarehouseCorrection(inj.warehouseNote);
      } else if (inj.kind === "CHARGEBACK_WEBHOOK" && inj.chargeback) {
        state.addChargebackWebhook(inj.chargeback);
      }
    }, Math.max(20, Math.round(inj.delayMs * latencyScale)));
  }

  runtime.sendEvent(
    SemanticEvent.create("case.opened", coordinator.getId(), {
      scenarioId: scenario.id,
      epoch: 1,
    }),
    coordinator.getId(),
  );

  try {
    await state.waitUntilComplete(resolved.mode === "live" ? 45_000 : 12_000);
  } finally {
    if (injectionTimer) clearTimeout(injectionTimer);
  }

  const verdict: FinalVerdict = state.verdict ?? "READY_FOR_HUMAN_APPROVAL";
  const chosenSeller = state.acceptedProposal?.debitSellerId ?? scenario.draft.debitedSellerId;
  const ledger = computeGroundedLedger(scenario, verdict, chosenSeller, null);

  return {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    mode: resolved.mode,
    architecture: "single-agent-baseline",
    verdict,
    finalEpoch: state.epoch,
    durationMs: state.elapsedMs(),
    concurrentOverlapVerified: false,
    overlapDetail: "Single sequential agent — no concurrent peer agent.",
    sentinelFinding: null,
    acceptedProposal: state.acceptedProposal,
    interceptions: [],
    ledger,
    timeline: state.timeline,
  };
}
