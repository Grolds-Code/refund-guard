import {
  Agent,
  createAgent,
  DeveloperMessageItem,
  ModelContext,
  SituationSpecification,
  type SituationContext,
  type SituationHandler,
  type Tool,
} from "@mozaik-ai/core";
import type { SellerId } from "../../finance/types.js";
import { RefundInterceptionGate } from "../interception.js";
import type {
  EvidenceUpdatedPayload,
  RefundGuardRuntimeApi,
  RefundGuardState,
} from "../runtime.js";

class WhenCaseOpenedOrRevalidationNeeded extends SituationSpecification {
  constructor(private readonly state: RefundGuardState) {
    super();
  }

  isSatisfiedBy({ event }: SituationContext): boolean {
    if (event.type === "case.opened") {
      return true;
    }
    if (event.type === "evidence.updated") {
      const payload = event.payload as EvidenceUpdatedPayload | undefined;
      return (
        this.state.allowPostAcceptanceRevalidation &&
        Boolean(payload?.invalidatedPriorApproval)
      );
    }
    return false;
  }
}

const REFUND_DESK_INSTRUCTION =
  "You are the Black Friday Refund Desk Agent. Read the customer refund ticket, order lines, and payout draft, then call `propose_refund` with the seller to debit and the current epoch. Never invent amounts; use the exact refund amount from the source record. If an interception gate blocks your tool call and provides verified Sentinel findings or a newer epoch, immediately call `propose_refund` again obeying the correction.";

export function createRefundDeskAgent(
  runtime: RefundGuardRuntimeApi,
  state: RefundGuardState,
): Agent {
  const proposeRefundTool: Tool = {
    type: "function",
    name: "propose_refund",
    description:
      "Submit a verified seller refund deduction proposal for human approval. Always specify exact debitSellerId and current epoch.",
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
      // Defensive guard: never accept a proposal whose epoch is already stale.
      const commitEpoch = state.epoch;
      if (args.epoch < commitEpoch) {
        return {
          accepted: false,
          reason: "SUPERSEDED_EVIDENCE",
          proposalEpoch: args.epoch,
          currentEpoch: commitEpoch,
        };
      }

      const finding = state.getLatestSentinelFinding();
      const cited = new Set<string>([
        state.scenario.ticket.ticketId,
        state.scenario.draft.draftId,
        ...state.scenario.settlements.map((s) => s.settlementId),
      ]);
      if (finding) {
        for (const id of finding.citedSourceIds) cited.add(id);
      }

      state.acceptedProposal = {
        epoch: commitEpoch,
        checkoutId: args.checkoutId,
        debitSellerId: args.debitSellerId,
        refundAmountKsh: state.scenario.draft.refundAmountKsh, // deterministic source amount
        rationale: args.rationale,
        citedSourceIds: [...cited],
      };

      const wasCorrected =
        state.interceptions.length > 0 ||
        state.supersededProposals.length > 0 ||
        args.debitSellerId !== state.scenario.draft.debitedSellerId;
      state.verdict = wasCorrected
        ? "CORRECTED_READY_FOR_APPROVAL"
        : "READY_FOR_HUMAN_APPROVAL";

      state.recordEvent(
        "proposal.accepted",
        "RefundDeskAgent",
        `Accepted refund proposal: debit ${args.debitSellerId} KSh ${state.scenario.draft.refundAmountKsh.toLocaleString("en-KE")} (epoch ${commitEpoch}, verdict=${state.verdict}).`,
        {
          debitSellerId: args.debitSellerId,
          epoch: commitEpoch,
          verdict: state.verdict,
          citedSourceIds: [...cited],
        },
      );

      return {
        accepted: true,
        verdict: state.verdict,
        debitSellerId: args.debitSellerId,
        epoch: commitEpoch,
        citedSourceIds: [...cited],
      };
    },
  };

  const onTrigger: SituationHandler = {
    specification: new WhenCaseOpenedOrRevalidationNeeded(state),
    processor: {
      apply({ event, participant }) {
        if (!(participant instanceof Agent)) return;

        const isRevalidation = event.type === "evidence.updated";
        const currentEpoch = state.epoch;
        const s = state.scenario;

        const prompt = [
          isRevalidation
            ? `REVALIDATION REQUIRED (epoch ${currentEpoch}): Earlier approval was invalidated by newer evidence. Re-review this Black Friday refund ticket and call \`propose_refund\` with epoch=${currentEpoch}.`
            : "Review this Black Friday customer refund ticket and payout draft, then call `propose_refund`.",
          `CHECKOUT_ID: ${s.checkoutId}`,
          `INITIAL_EPOCH: ${currentEpoch}`,
          `REFUND_AMOUNT_KSH: ${s.draft.refundAmountKsh}`,
          "POLICY:",
          s.policySummary,
          "ORDER_LINES:",
          ...s.orderLines.map(
            (l) =>
              `- ${l.lineId} | ${l.sellerId} (${s.sellers[l.sellerId].name}) | ${l.sku} | ${l.itemTitle} | KSh ${l.amountKsh}`,
          ),
          "CUSTOMER_TICKET:",
          `${s.ticket.ticketId} (${s.ticket.submittedAt}): ${s.ticket.message}`,
          "PAYOUT_DRAFT:",
          `DRAFT_ID: ${s.draft.draftId}`,
          `DRAFT_DEBITED_SELLER: ${s.draft.debitedSellerId}`,
          `DRAFT_TOTAL_KSH: ${s.draft.totalBatchSettlementKsh}`,
          "Call propose_refund now. If intercepted with verified Sentinel findings, obey the mandatory correction.",
        ].join("\n");

        state.notifyRefundDeskLoopStarted();
        state.recordEvent(
          "agent.loop_started",
          "RefundDeskAgent",
          isRevalidation
            ? `Started post-invalidation revalidation loop for ${s.checkoutId} (epoch ${currentEpoch}).`
            : `Started concurrent review loop for ${s.checkoutId} (ticket ${s.ticket.ticketId}, draft ${s.draft.draftId}).`,
          { epoch: currentEpoch, isRevalidation },
        );

        const gate = new RefundInterceptionGate(state);
        const context = isRevalidation
          ? ModelContext.create().addContextItem(
              DeveloperMessageItem.create(REFUND_DESK_INSTRUCTION),
            )
          : participant.getMemory().getContext();

        runtime.runLoop(
          participant.getId(),
          prompt,
          {
            model: state.modelName,
            context,
            tools: participant.getTools(),
          },
          gate,
        );
      },
    },
  };

  return createAgent({
    name: "RefundDeskAgent",
    capabilities: ["refund-policy", "ticket-triage", "propose-refund"],
    instruction: REFUND_DESK_INSTRUCTION,
    tools: [proposeRefundTool],
    handlers: [onTrigger],
  });
}
