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
 * Ticket-and-Draft Baseline:
 * Single sequential agent that sees ONLY the customer ticket and payout draft
 * (no warehouse feed, no dispute feed, no concurrent interception).
 * Measures the value of cross-system evidence grounding + interception combined.
 */
export async function runTicketAndDraftBaseline(
  scenario: ScenarioFixture,
  options?: { modeOverride?: "auto" | "live" | "mock"; latencyScale?: number },
): Promise<CaseRunReport> {
  return runBaselineVariant(scenario, "ticket-and-draft-baseline", options);
}

/**
 * Fair Single-Agent Snapshot Baseline (isolates concurrency & mid-flight interception):
 * Receives the EXACT SAME t=0 evidence as RefundGuard (customer ticket, payout draft,
 * full policy, initial warehouse return note, and any initial linked dispute), using
 * the exact same deterministic ledger calculator and inference runner.
 *
 * Because it runs as a single non-intercepted pass on the t=0 snapshot, it handles
 * static Cases 1-3 accurately, but misses mid-flight updates arriving while the review
 * is running (Case 4 late warehouse correction and Case 5 mid-flight dispute).
 */
export async function runSingleAgentSnapshotBaseline(
  scenario: ScenarioFixture,
  options?: { modeOverride?: "auto" | "live" | "mock"; latencyScale?: number },
): Promise<CaseRunReport> {
  return runBaselineVariant(scenario, "single-agent-snapshot-baseline", options);
}

async function runBaselineVariant(
  scenario: ScenarioFixture,
  architecture: "ticket-and-draft-baseline" | "single-agent-snapshot-baseline",
  options?: { modeOverride?: "auto" | "live" | "mock"; latencyScale?: number },
): Promise<CaseRunReport> {
  const latencyScale = options?.latencyScale ?? 1;
  const resolved = resolveInferenceMode({
    modeOverride: options?.modeOverride,
    latencyScale,
  });

  const runtime = createRefundGuardRuntime();
  const state = new RefundGuardState(scenario, resolved.mode, resolved.modelName, false);

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
        citedSourceIds:
          architecture === "single-agent-snapshot-baseline"
            ? [
                scenario.ticket.ticketId,
                scenario.draft.draftId,
                scenario.initialWarehouseNote.noteId,
              ]
            : [scenario.ticket.ticketId, scenario.draft.draftId],
      };
      const wasCorrected = args.debitSellerId !== scenario.draft.debitedSellerId;
      state.verdict = wasCorrected
        ? "CORRECTED_READY_FOR_APPROVAL"
        : "READY_FOR_HUMAN_APPROVAL";
      state.recordEvent(
        "proposal.accepted",
        architecture,
        `Approved debit=${args.debitSellerId} KSh ${scenario.draft.refundAmountKsh.toLocaleString("en-KE")} (no concurrent sentinel or mid-flight interception).`,
      );
      return { accepted: true, debitSellerId: args.debitSellerId };
    },
  };

  const holdForReviewTool: Tool = {
    type: "function",
    name: "hold_for_review",
    description: "Hold refund payout for human review when evidence is missing or disputed.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: [
            "HOLD_MISSING_EVIDENCE",
            "FROZEN_DISPUTE_COLLISION",
            "VERIFY_DISPUTE_MATCH",
          ],
        },
        reason: { type: "string" },
      },
      required: ["verdict", "reason"],
      additionalProperties: false,
    },
    invoke: async (args: {
      verdict: "HOLD_MISSING_EVIDENCE" | "FROZEN_DISPUTE_COLLISION" | "VERIFY_DISPUTE_MATCH";
      reason: string;
    }) => {
      state.acceptedProposal = null;
      state.verdict = args.verdict;
      state.recordEvent("proposal.held", architecture, `Held case (${args.verdict}): ${args.reason}`);
      return { held: true, verdict: args.verdict };
    },
  };

  const tools =
    architecture === "single-agent-snapshot-baseline"
      ? [proposeRefundTool, holdForReviewTool]
      : [proposeRefundTool];

  const onOpened: SituationHandler = {
    specification: new WhenCaseOpened(),
    processor: {
      apply({ participant }) {
        if (!(participant instanceof Agent)) return;
        const lines = [
          architecture === "single-agent-snapshot-baseline"
            ? "Review the customer ticket, payout draft, policy, initial warehouse note, and any initial dispute. Call `propose_refund` if verified, or `hold_for_review` if missing evidence or disputed."
            : "Review this Black Friday customer refund ticket and payout draft, then call `propose_refund`.",
          `CHECKOUT_ID: ${scenario.checkoutId}`,
          `INITIAL_EPOCH: 1`,
          `CURRENT_EPOCH: 1`,
          `REFUND_AMOUNT_KSH: ${scenario.draft.refundAmountKsh}`,
          "CUSTOMER_TICKET:",
          `${scenario.ticket.ticketId}: ${scenario.ticket.message}`,
          "PAYOUT_DRAFT:",
          `DRAFT_ID: ${scenario.draft.draftId}`,
          `DRAFT_DEBITED_SELLER: ${scenario.draft.debitedSellerId}`,
          `DRAFT_TOTAL_KSH: ${scenario.draft.totalBatchSettlementKsh}`,
        ];

        if (architecture === "single-agent-snapshot-baseline") {
          const initialDispute = state.getLatestRelevantChargeback();
          lines.push(
            "POLICY:",
            scenario.policySummary,
            `WAREHOUSE_NOTE_ID: ${scenario.initialWarehouseNote.noteId}`,
            "WAREHOUSE_NOTE_TEXT:",
            scenario.initialWarehouseNote.text,
            "CHARGEBACK_SECTION:",
            initialDispute
              ? [
                  `DISPUTE_ID: ${initialDispute.chargeback.disputeId}`,
                  `DISPUTE_STATUS: ${initialDispute.chargeback.status}`,
                  `MATCH_STATE: ${initialDispute.evaluation.matchState}`,
                  `NARRATIVE: ${initialDispute.chargeback.narrative}`,
                ].join("\n")
              : "NONE",
            "END_EVIDENCE",
          );
        }

        state.notifyRefundDeskLoopStarted();
        runtime.runLoop(participant.getId(), lines.join("\n"), {
          model: state.modelName,
          context: participant.getMemory().getContext(),
          tools: participant.getTools(),
        });
      },
    },
  };

  const singleAgent = createAgent({
    name: architecture,
    capabilities: ["refund-policy"],
    instruction:
      architecture === "single-agent-snapshot-baseline"
        ? "Review the full t=0 snapshot (ticket, draft, policy, warehouse note, initial dispute) and call propose_refund or hold_for_review."
        : "Review the customer refund ticket and payout draft, then call propose_refund.",
    tools,
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
              const w = state.refundDeskWindows.find((x) => !x.endedAtMs);
              if (w) w.endedAtMs = Date.now();
              state.notifyRefundDeskLoopSettled("READY_FOR_HUMAN_APPROVAL");
            }
          },
        },
      },
    ],
  });

  runtime.join(coordinator);
  runtime.join(singleAgent);
  runtime.join(observer);

  // Mid-flight events arrive in the background while the single agent is running,
  // but without a concurrent Sentinel or InterceptionHandler they are not intercepted.
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
  const chosenSeller =
    verdict === "READY_FOR_HUMAN_APPROVAL" || verdict === "CORRECTED_READY_FOR_APPROVAL"
      ? (state.acceptedProposal?.debitSellerId ?? scenario.draft.debitedSellerId)
      : null;
  const ledger = computeGroundedLedger(scenario, verdict, chosenSeller, null);

  return {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    mode: resolved.mode,
    modelName: resolved.modelName,
    architecture,
    verdict,
    finalEpoch: state.epoch,
    durationMs: state.elapsedMs(),
    concurrentOverlapVerified: false,
    overlapDetail: "Single sequential agent: no concurrent peer agent.",
    sentinelFinding: null,
    disputeEvaluation: state.lastDisputeEvaluation,
    acceptedProposal: state.acceptedProposal,
    supersededProposals: state.supersededProposals,
    interceptions: [],
    ledger,
    timeline: state.timeline,
  };
}
