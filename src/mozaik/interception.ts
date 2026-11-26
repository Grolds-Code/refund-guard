import {
  FunctionCallOutputItem,
  ModelMessageItem,
  type ExecutableTransition,
  type InterceptionHandler,
} from "@mozaik-ai/core";
import type {
  InterceptionReason,
  InterceptionRecord,
  SellerId,
} from "../finance/types.js";
import type { RefundGuardState } from "./runtime.js";

interface ProposeRefundArgs {
  checkoutId?: string;
  debitSellerId?: SellerId;
  refundAmountKsh?: number;
  epoch?: number;
  rationale?: string;
}

/**
 * Awaited Mozaik InterceptionHandler guarding Agent 1's `propose_refund` function_call.
 *
 * Before `propose_refund` can execute, this gate:
 * 1. Awaits Agent 2 (DisputeFulfillmentSentinel) for the latest RuntimeState epoch.
 * 2. Verifies any dispute webhook via deterministic payment-link matching:
 *    - Active verified match -> HALT (`FROZEN_DISPUTE_COLLISION`) to block an unsafe
 *      cross-system refund/payout proposal while the dispute is open.
 *    - Ambiguous partial match -> HALT (`VERIFY_DISPUTE_MATCH`) for operator verification.
 *    - Unrelated or inactive dispute -> ignored; never freezes a clean checkout.
 * 3. Checks for missing or ambiguous physical return evidence -> fail-closed hold.
 * 4. Checks for superseded evidence epochs -> blocks stale proposal & forces re-plan.
 * 5. Checks whether proposed seller debit matches Sentinel's verified warehouse seller.
 */
export class RefundInterceptionGate implements InterceptionHandler {
  private attemptCount = 0;
  private readonly maxReplanAttempts = 3;

  constructor(private readonly state: RefundGuardState) {}

  isSatisfiedBy(transition: ExecutableTransition): boolean {
    if (transition.nextStateId !== "function_call") {
      return false;
    }
    return transition.input.call.name === "propose_refund";
  }

  async handle(transition: ExecutableTransition): Promise<ExecutableTransition> {
    if (transition.nextStateId !== "function_call") {
      return transition;
    }

    this.attemptCount += 1;
    const { call, inferenceInput } = transition.input;
    const args = parseArgs(call.args);
    const proposedSeller: SellerId =
      args.debitSellerId === "SELLER-A" || args.debitSellerId === "SELLER-B"
        ? args.debitSellerId
        : this.state.scenario.draft.debitedSellerId;
    const proposalEpoch = typeof args.epoch === "number" ? args.epoch : 1;

    this.state.recordEvent(
      "interception.inspecting",
      "RefundInterceptionGate",
      `Intercepted propose_refund(debit=${proposedSeller}, epoch=${proposalEpoch}) before execution; awaiting Sentinel verification for epoch ${this.state.epoch}.`,
      { proposedSeller, proposalEpoch, currentEpoch: this.state.epoch },
    );

    // Wait for Sentinel's finding on the latest epoch (and re-check if epoch bumps while waiting).
    let finding = await this.state.waitForSentinelForCurrentEpoch();
    while (finding && finding.epoch < this.state.epoch) {
      finding = await this.state.waitForSentinelForCurrentEpoch();
    }

    const currentEpoch = this.state.epoch;
    const relevantDispute = this.state.getLatestRelevantChargeback();

    // 1A. Verified active dispute linked to this payment -> block unsafe cross-system refund proposal
    if (relevantDispute?.evaluation.matchState === "VERIFIED_ACTIVE_MATCH") {
      const { chargeback, evaluation } = relevantDispute;
      const cited = Array.from(
        new Set([
          chargeback.disputeId,
          ...(finding?.citedSourceIds ?? []),
          ...this.state.scenario.settlements.map((s) => s.settlementId),
        ]),
      );
      const detail = `Blocked unsafe cross-system refund/payout proposal (KSh ${this.state.scenario.ticket.requestedRefundKsh.toLocaleString("en-KE")}): ${evaluation.reason}`;
      this.recordInterception({
        blockedSellerId: proposedSeller,
        proposalEpoch,
        currentEpoch,
        reason: "UNSAFE_CROSS_SYSTEM_REFUND_BLOCKED",
        detail,
        actionTaken: "HALT_FOR_HUMAN_REVIEW",
        citedSourceIds: cited,
      });
      this.state.verdict = "FROZEN_DISPUTE_COLLISION";
      return this.haltForHumanReview("FROZEN_DISPUTE_COLLISION", detail, cited);
    }

    // 1B. Ambiguous dispute match -> ask human operator to verify linkage before releasing funds
    if (
      relevantDispute?.evaluation.matchState === "AMBIGUOUS_MATCH" ||
      finding?.status === "DISPUTE_AMBIGUOUS"
    ) {
      const disputeId =
        relevantDispute?.chargeback.disputeId ?? finding?.disputeId ?? "UNKNOWN";
      const cited = Array.from(
        new Set([
          disputeId,
          ...(finding?.citedSourceIds ?? []),
          ...this.state.scenario.settlements.map((s) => s.settlementId),
        ]),
      );
      const detail =
        relevantDispute?.evaluation.reason ??
        `Dispute ${disputeId} partially matches ${this.state.scenario.checkoutId}; operator verification required before approving payout.`;
      this.recordInterception({
        blockedSellerId: proposedSeller,
        proposalEpoch,
        currentEpoch,
        reason: "AMBIGUOUS_DISPUTE_MATCH",
        detail,
        actionTaken: "HALT_FOR_HUMAN_REVIEW",
        citedSourceIds: cited,
      });
      this.state.verdict = "VERIFY_DISPUTE_MATCH";
      return this.haltForHumanReview("VERIFY_DISPUTE_MATCH", detail, cited);
    }

    // 2. Missing or ambiguous physical return evidence -> HALT fail-closed
    if (!finding || finding.status === "MISSING_OR_AMBIGUOUS" || !finding.verifiedSellerId) {
      const cited = finding?.citedSourceIds ?? [this.state.getLatestWarehouseNote().noteId];
      const detail = `Fail-closed hold: warehouse record ${this.state.getLatestWarehouseNote().noteId} does not verify physical receipt of a specific seller SKU for ${this.state.scenario.checkoutId}. Refusing to debit ${proposedSeller} without verified return evidence.`;
      this.recordInterception({
        blockedSellerId: proposedSeller,
        proposalEpoch,
        currentEpoch,
        reason: "MISSING_EVIDENCE",
        detail,
        actionTaken: "HALT_FOR_HUMAN_REVIEW",
        citedSourceIds: cited,
      });
      this.state.verdict = "HOLD_MISSING_EVIDENCE";
      return this.haltForHumanReview("HOLD_MISSING_EVIDENCE", detail, cited);
    }

    // 3. Superseded evidence epoch -> REJECT stale proposal & force re-plan on current epoch
    if (proposalEpoch < currentEpoch) {
      const detail = `Rejected superseded proposal (epoch ${proposalEpoch} < current epoch ${currentEpoch}). Late update ${finding.evidenceNoteId} establishes ${finding.verifiedSellerId} (${finding.verifiedLineId}) is liable. Re-plan on epoch ${currentEpoch}.`;
      this.recordInterception({
        blockedSellerId: proposedSeller,
        proposalEpoch,
        currentEpoch,
        reason: "SUPERSEDED_EVIDENCE",
        detail,
        actionTaken: "REWRITE_AND_REPLAN",
        citedSourceIds: finding.citedSourceIds,
      });
      return this.rewriteForReplan(
        call.callId,
        inferenceInput,
        "SUPERSEDED_EVIDENCE",
        detail,
        finding.verifiedSellerId,
        currentEpoch,
        finding.citedSourceIds,
      );
    }

    // 4. Wrong-seller allocation (zero-sum trap) -> REJECT & rewrite with Sentinel's verified seller
    if (proposedSeller !== finding.verifiedSellerId) {
      const detail = `Zero-sum misallocation blocked: draft/proposal charged ${proposedSeller}, but Sentinel verified return of ${finding.verifiedLineId} belonging to ${finding.verifiedSellerId} (${finding.evidenceNoteId}). Total remains KSh ${this.state.scenario.draft.totalBatchSettlementKsh.toLocaleString("en-KE")}, but seller deduction must move to ${finding.verifiedSellerId}.`;
      this.recordInterception({
        blockedSellerId: proposedSeller,
        proposalEpoch,
        currentEpoch,
        reason: "WRONG_SELLER_ALLOCATION",
        detail,
        actionTaken: "REWRITE_AND_REPLAN",
        citedSourceIds: finding.citedSourceIds,
      });
      return this.rewriteForReplan(
        call.callId,
        inferenceInput,
        "WRONG_SELLER_ALLOCATION",
        detail,
        finding.verifiedSellerId,
        currentEpoch,
        finding.citedSourceIds,
      );
    }

    // 5. All checks passed! Allow `propose_refund` to execute.
    this.state.recordEvent(
      "interception.cleared",
      "RefundInterceptionGate",
      `Cleared propose_refund(debit=${proposedSeller}, epoch=${currentEpoch}): matches Sentinel finding (${finding.evidenceNoteId}, ${finding.verifiedLineId}) with zero active linked disputes.`,
      {
        approvedSellerId: proposedSeller,
        epoch: currentEpoch,
        citedSourceIds: finding.citedSourceIds,
      },
    );
    return transition;
  }

  private recordInterception(input: {
    blockedSellerId: SellerId;
    proposalEpoch: number;
    currentEpoch: number;
    reason: InterceptionReason;
    detail: string;
    actionTaken: "REWRITE_AND_REPLAN" | "HALT_FOR_HUMAN_REVIEW";
    citedSourceIds: readonly string[];
  }): void {
    const rec: InterceptionRecord = {
      timestampMs: this.state.elapsedMs(),
      attemptNumber: this.attemptCount,
      ...input,
    };
    this.state.interceptions.push(rec);
    this.state.recordEvent(
      "interception.blocked",
      "RefundInterceptionGate",
      `[${rec.reason}] ${rec.detail}`,
      {
        reason: rec.reason,
        actionTaken: rec.actionTaken,
        blockedSellerId: rec.blockedSellerId,
        proposalEpoch: rec.proposalEpoch,
        currentEpoch: rec.currentEpoch,
        citedSourceIds: rec.citedSourceIds,
      },
    );
  }

  private rewriteForReplan(
    callId: string,
    inferenceInput: Extract<ExecutableTransition, { nextStateId: "function_call" }>["input"]["inferenceInput"],
    reason: InterceptionReason,
    detail: string,
    verifiedSellerId: SellerId,
    currentEpoch: number,
    citedSourceIds: readonly string[],
  ): ExecutableTransition {
    if (this.attemptCount >= this.maxReplanAttempts) {
      this.state.verdict = "HOLD_MISSING_EVIDENCE";
      return this.haltForHumanReview(
        "HOLD_MISSING_EVIDENCE",
        `Max interception replan attempts (${this.maxReplanAttempts}) reached: ${detail}`,
        citedSourceIds,
      );
    }

    // Keep context protocol-valid for live OpenAI/Anthropic/Gemini endpoints by
    // appending a tool output matching the blocked FunctionCallItem's callId.
    const blockedToolOutput = FunctionCallOutputItem.create(
      callId,
      JSON.stringify({
        status: "INTERCEPTED_AND_BLOCKED",
        reason,
        currentEpoch,
        verifiedSellerId,
        citedSourceIds,
        detail,
      }),
    );

    const updatedInput = {
      ...inferenceInput,
      context: inferenceInput.context.addContextItems([blockedToolOutput]),
    };

    return {
      nextStateId: "message_received",
      input: {
        content: [
          `INTERCEPTION_FEEDBACK (${reason}):`,
          detail,
          `MANDATORY CORRECTION: Call propose_refund again with debitSellerId="${verifiedSellerId}", epoch=${currentEpoch}, checkoutId="${this.state.scenario.checkoutId}", refundAmountKsh=${this.state.scenario.draft.refundAmountKsh}, citing [${citedSourceIds.join(", ")}].`,
        ].join("\n"),
        input: updatedInput,
      },
    };
  }

  private haltForHumanReview(
    verdict: "HOLD_MISSING_EVIDENCE" | "FROZEN_DISPUTE_COLLISION" | "VERIFY_DISPUTE_MATCH",
    detail: string,
    citedSourceIds: readonly string[],
  ): ExecutableTransition {
    return {
      nextStateId: "model_message",
      input: {
        answer: ModelMessageItem.rehydrate({
          text: `${verdict}: ${detail} [Sources: ${citedSourceIds.join(", ")}]`,
        }),
      },
    };
  }
}

function parseArgs(raw: string): ProposeRefundArgs {
  try {
    return JSON.parse(raw) as ProposeRefundArgs;
  } catch {
    return {};
  }
}
