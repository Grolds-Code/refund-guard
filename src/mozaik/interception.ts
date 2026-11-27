import {
  FunctionCallOutputItem,
  ModelMessageItem,
  type ExecutableTransition,
  type InterceptionHandler,
} from "@mozaik-ai/core";
import { checkMoneyReconciliation } from "../finance/ledger.js";
import type {
  FinalVerdict,
  InterceptionReason,
  InterceptionRecord,
  SellerId,
  SentinelFinding,
} from "../finance/types.js";
import type { RefundGuardState } from "./runtime.js";

interface ProposeRefundArgs {
  checkoutId?: unknown;
  debitSellerId?: unknown;
  refundAmountKsh?: unknown;
  epoch?: unknown;
  rationale?: unknown;
}

/**
 * Independently validates every field of a SentinelFinding against immutable
 * RuntimeState records so the gate never blindly trusts hallucinated or stale findings.
 */
export function validateSentinelFindingForClearance(
  state: RefundGuardState,
  finding: SentinelFinding | null,
): { valid: boolean; reason?: string } {
  if (!finding) {
    return { valid: false, reason: `No Sentinel finding published for epoch ${state.epoch}.` };
  }
  if (finding.epoch !== state.epoch) {
    return {
      valid: false,
      reason: `Sentinel finding epoch (${finding.epoch}) does not match current epoch (${state.epoch}).`,
    };
  }
  if (finding.checkoutId && finding.checkoutId !== state.scenario.checkoutId) {
    return {
      valid: false,
      reason: `Sentinel finding checkoutId (${finding.checkoutId}) does not match ${state.scenario.checkoutId}.`,
    };
  }
  if (finding.status !== "VERIFIED_RETURN") {
    return {
      valid: false,
      reason: `Sentinel status is ${finding.status} (not VERIFIED_RETURN).`,
    };
  }
  if (finding.confidence !== "HIGH") {
    return {
      valid: false,
      reason: `Sentinel confidence is ${finding.confidence}; HIGH confidence is required to clear a seller deduction.`,
    };
  }
  if (finding.verifiedSellerId !== "SELLER-A" && finding.verifiedSellerId !== "SELLER-B") {
    return {
      valid: false,
      reason: `Sentinel verifiedSellerId (${String(finding.verifiedSellerId)}) is invalid.`,
    };
  }
  if (!finding.verifiedLineId) {
    return { valid: false, reason: "Sentinel finding is missing verifiedLineId." };
  }
  const matchingOrderLine = state.scenario.orderLines.find(
    (line) =>
      line.lineId === finding.verifiedLineId &&
      line.sellerId === finding.verifiedSellerId &&
      line.checkoutId === state.scenario.checkoutId,
  );
  if (!matchingOrderLine) {
    return {
      valid: false,
      reason: `Sentinel line ${finding.verifiedLineId} does not belong to ${finding.verifiedSellerId} on ${state.scenario.checkoutId}.`,
    };
  }
  const latestNote = state.getLatestWarehouseNote();
  if (finding.evidenceNoteId !== latestNote.noteId) {
    return {
      valid: false,
      reason: `Sentinel evidenceNoteId (${finding.evidenceNoteId}) does not match latest warehouse note (${latestNote.noteId}).`,
    };
  }
  return { valid: true };
}

/**
 * Awaited Mozaik InterceptionHandler guarding Agent 1's `propose_refund` function_call.
 *
 * Before `propose_refund` can execute, this gate enforces:
 * 1. Idempotency: blocks duplicate `propose_refund` calls once a proposal is already
 *    accepted for the current epoch.
 * 2. Bounded wait for Agent 2 (DisputeFulfillmentSentinel) on the latest epoch (never spins).
 * 3. Deterministic payment-link dispute checks (`VERIFIED_ACTIVE_MATCH`, `VERIFIED_LOST_DISPUTE`,
 *    and `AMBIGUOUS_MATCH`).
 * 4. Deterministic money reconciliation (posted refund vs. draft refund vs. proposed amount).
 * 5. Strict validation of BOTH Sentinel's finding (exact checkout, current epoch, HIGH confidence,
 *    latest warehouse note ID, and verified seller/line ownership) AND RefundDesk's arguments
 *    (exact checkout, exact amount, valid seller without draft fallback, non-future epoch).
 * 6. Superseded epoch rejection and zero-sum wrong-seller correction via live tool-call rewrite.
 */
export class RefundInterceptionGate implements InterceptionHandler {
  private attemptCount = 0;
  private readonly maxReplanAttempts = 3;

  constructor(
    private readonly state: RefundGuardState,
    private readonly waitTimeoutMs = 6_000,
  ) {}

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

    const rawSeller = args.debitSellerId;
    const isValidSeller = rawSeller === "SELLER-A" || rawSeller === "SELLER-B";
    const proposedSellerForLog: SellerId | "INVALID" = isValidSeller ? rawSeller : "INVALID";
    const proposalEpoch =
      typeof args.epoch === "number" && Number.isInteger(args.epoch) ? args.epoch : -1;

    // 0. Prevent repeat/duplicate proposals once already accepted for this epoch
    if (
      this.state.acceptedProposal !== null &&
      this.state.acceptedProposal.epoch === this.state.epoch
    ) {
      const detail = `Blocked duplicate propose_refund call at epoch ${this.state.epoch}: proposal for ${this.state.acceptedProposal.debitSellerId} was already accepted for this epoch.`;
      this.recordInterception({
        blockedSellerId: proposedSellerForLog,
        proposalEpoch,
        currentEpoch: this.state.epoch,
        reason: "DUPLICATE_PROPOSAL_BLOCKED",
        detail,
        actionTaken: "HALT_FOR_HUMAN_REVIEW",
        citedSourceIds: this.state.acceptedProposal.citedSourceIds,
      });
      return {
        nextStateId: "model_message",
        input: {
          answer: ModelMessageItem.rehydrate({
            text: `Proposal already accepted for epoch ${this.state.epoch} (${this.state.acceptedProposal.debitSellerId}); duplicate propose_refund blocked.`,
          }),
        },
      };
    }

    this.state.recordEvent(
      "interception.inspecting",
      "RefundInterceptionGate",
      `Intercepted propose_refund(debit=${proposedSellerForLog}, epoch=${proposalEpoch}) before execution; awaiting Sentinel verification for epoch ${this.state.epoch}.`,
      { proposedSeller: proposedSellerForLog, proposalEpoch, currentEpoch: this.state.epoch },
    );

    // Bounded wait for Sentinel's finding on the latest epoch (never infinite loop).
    let finding: SentinelFinding | null = null;
    for (let round = 0; round < 3; round += 1) {
      finding = await this.state.waitForSentinelForCurrentEpoch(this.waitTimeoutMs);
      if (finding && finding.epoch === this.state.epoch) {
        break;
      }
      if (!finding) {
        break;
      }
    }

    const currentEpoch = this.state.epoch;
    const relevantDispute = this.state.getLatestRelevantChargeback();

    // 1A. Verified active OR prior lost dispute linked to this payment -> hard freeze
    if (
      relevantDispute?.evaluation.matchState === "VERIFIED_ACTIVE_MATCH" ||
      relevantDispute?.evaluation.matchState === "VERIFIED_LOST_DISPUTE"
    ) {
      const { chargeback, evaluation } = relevantDispute;
      const isLost = evaluation.matchState === "VERIFIED_LOST_DISPUTE";
      const cited = Array.from(
        new Set([
          chargeback.disputeId,
          ...(finding?.citedSourceIds ?? []),
          ...this.state.scenario.settlements.map((s) => s.settlementId),
        ]),
      );
      const detail = isLost
        ? `Blocked refund proposal (KSh ${this.state.scenario.ticket.requestedRefundKsh.toLocaleString("en-KE")}): ${evaluation.reason}`
        : `Blocked unsafe cross-system refund/payout proposal (KSh ${this.state.scenario.ticket.requestedRefundKsh.toLocaleString("en-KE")}): ${evaluation.reason}`;
      this.recordInterception({
        blockedSellerId: proposedSellerForLog,
        proposalEpoch,
        currentEpoch,
        reason: isLost
          ? "PRIOR_DISPUTE_LOST_BLOCKED"
          : "UNSAFE_CROSS_SYSTEM_REFUND_BLOCKED",
        detail,
        actionTaken: "HALT_FOR_HUMAN_REVIEW",
        citedSourceIds: cited,
      });
      this.state.verdict = "FROZEN_DISPUTE_COLLISION";
      return this.haltForHumanReview("FROZEN_DISPUTE_COLLISION", detail, cited);
    }

    // 1B. Ambiguous or conflicting dispute signals -> ask human operator to verify
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
        blockedSellerId: proposedSellerForLog,
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

    // 2. Deterministic money reconciliation check on source settlements & draft
    const sourceRecon = checkMoneyReconciliation(this.state.scenario);
    if (!sourceRecon.ok) {
      const cited = [
        this.state.scenario.draft.draftId,
        ...this.state.scenario.settlements.map((s) => s.settlementId),
      ];
      const detail = `Money reconciliation mismatch blocked clearance: ${sourceRecon.error}`;
      this.recordInterception({
        blockedSellerId: proposedSellerForLog,
        proposalEpoch,
        currentEpoch,
        reason: "RECONCILIATION_MISMATCH",
        detail,
        actionTaken: "HALT_FOR_HUMAN_REVIEW",
        citedSourceIds: cited,
      });
      this.state.verdict = "HOLD_RECONCILIATION_MISMATCH";
      return this.haltForHumanReview("HOLD_RECONCILIATION_MISMATCH", detail, cited);
    }

    // 3. Validate Sentinel finding strictly (never blindly trust unverified/stale/invented fields)
    const findingCheck = validateSentinelFindingForClearance(this.state, finding);
    if (!findingCheck.valid || !finding || !finding.verifiedSellerId) {
      const isMissingStatus = !finding || finding.status === "MISSING_OR_AMBIGUOUS";
      const cited = Array.from(
        new Set([
          this.state.getLatestWarehouseNote().noteId,
          ...(finding?.citedSourceIds ?? []),
        ]),
      );
      const detail = isMissingStatus
        ? `Fail-closed hold: warehouse record ${this.state.getLatestWarehouseNote().noteId} does not verify physical receipt of a specific seller SKU for ${this.state.scenario.checkoutId}. (${findingCheck.reason ?? "missing evidence"})`
        : `Fail-closed hold: Sentinel finding rejected by gate validation (${findingCheck.reason}). Refusing to debit ${proposedSellerForLog}.`;
      this.recordInterception({
        blockedSellerId: proposedSellerForLog,
        proposalEpoch,
        currentEpoch,
        reason: isMissingStatus ? "MISSING_EVIDENCE" : "INVALID_PROPOSAL_OR_FINDING",
        detail,
        actionTaken: "HALT_FOR_HUMAN_REVIEW",
        citedSourceIds: cited,
      });
      this.state.verdict =
        !finding && this.state.revalidationRequestedForEpoch !== null
          ? "PENDING_REVALIDATION"
          : "HOLD_MISSING_EVIDENCE";
      return this.haltForHumanReview(this.state.verdict, detail, cited);
    }

    // 4. Validate RefundDesk proposal arguments strictly (no silent fallback to draft seller!)
    const proposedCheckoutId =
      typeof args.checkoutId === "string" ? args.checkoutId.trim() : "";
    const proposedAmountKsh =
      typeof args.refundAmountKsh === "number" ? args.refundAmountKsh : NaN;
    const argErrors: string[] = [];
    if (proposedCheckoutId !== this.state.scenario.checkoutId) {
      argErrors.push(
        `checkoutId "${proposedCheckoutId}" != "${this.state.scenario.checkoutId}"`,
      );
    }
    if (!isValidSeller) {
      argErrors.push(`invalid debitSellerId "${String(rawSeller)}"`);
    }
    if (proposedAmountKsh !== sourceRecon.expectedRefundKsh) {
      argErrors.push(
        `refundAmountKsh (${String(args.refundAmountKsh)}) != expected (${sourceRecon.expectedRefundKsh})`,
      );
    }
    if (proposalEpoch < 1 || proposalEpoch > currentEpoch) {
      argErrors.push(`invalid epoch (${proposalEpoch}) vs current epoch (${currentEpoch})`);
    }
    if (argErrors.length > 0) {
      const detail = `Invalid propose_refund payload rejected by gate: ${argErrors.join("; ")}.`;
      this.recordInterception({
        blockedSellerId: proposedSellerForLog,
        proposalEpoch,
        currentEpoch,
        reason: "INVALID_PROPOSAL_OR_FINDING",
        detail,
        actionTaken: "HALT_FOR_HUMAN_REVIEW",
        citedSourceIds: finding.citedSourceIds,
      });
      this.state.verdict =
        proposedAmountKsh !== sourceRecon.expectedRefundKsh
          ? "HOLD_RECONCILIATION_MISMATCH"
          : "HOLD_MISSING_EVIDENCE";
      return this.haltForHumanReview(this.state.verdict, detail, finding.citedSourceIds);
    }

    const proposedSeller: SellerId = rawSeller as SellerId;

    // 5. Superseded evidence epoch -> REJECT stale proposal & force re-plan on current epoch
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
        call,
        inferenceInput,
        "SUPERSEDED_EVIDENCE",
        detail,
        finding.verifiedSellerId,
        currentEpoch,
        sourceRecon.expectedRefundKsh,
        finding.citedSourceIds,
      );
    }

    // 6. Wrong-seller allocation (zero-sum trap) -> REJECT & rewrite with Sentinel's verified seller
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
        call,
        inferenceInput,
        "WRONG_SELLER_ALLOCATION",
        detail,
        finding.verifiedSellerId,
        currentEpoch,
        sourceRecon.expectedRefundKsh,
        finding.citedSourceIds,
      );
    }

    // 7. All checks passed! Allow `propose_refund` to execute.
    this.state.recordEvent(
      "interception.cleared",
      "RefundInterceptionGate",
      `Cleared propose_refund(debit=${proposedSeller}, amount=KSh ${sourceRecon.expectedRefundKsh.toLocaleString("en-KE")}, epoch=${currentEpoch}): matches Sentinel finding (${finding.evidenceNoteId}, ${finding.verifiedLineId}) with reconciled totals and zero blocking disputes.`,
      {
        approvedSellerId: proposedSeller,
        epoch: currentEpoch,
        citedSourceIds: finding.citedSourceIds,
      },
    );
    return transition;
  }

  private recordInterception(input: {
    blockedSellerId: SellerId | "INVALID";
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
    call: Extract<ExecutableTransition, { nextStateId: "function_call" }>["input"]["call"],
    inferenceInput: Extract<ExecutableTransition, { nextStateId: "function_call" }>["input"]["inferenceInput"],
    reason: InterceptionReason,
    detail: string,
    verifiedSellerId: SellerId,
    currentEpoch: number,
    expectedRefundKsh: number,
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

    // Mozaik adds [call, outputItem] only after function_call finishes. Since we
    // intercepted before execution, append BOTH the FunctionCallItem and its
    // blocked FunctionCallOutputItem so live OpenAI/Anthropic/Gemini APIs receive
    // a valid assistant(tool_calls) -> tool message pair.
    const blockedToolOutput = FunctionCallOutputItem.create(
      call.callId,
      JSON.stringify({
        status: "INTERCEPTED_AND_BLOCKED",
        reason,
        currentEpoch,
        verifiedSellerId,
        expectedRefundKsh,
        citedSourceIds,
        detail,
      }),
    );

    const updatedInput = {
      ...inferenceInput,
      context: inferenceInput.context.addContextItems([call, blockedToolOutput]),
    };

    return {
      nextStateId: "message_received",
      input: {
        content: [
          `INTERCEPTION_FEEDBACK (${reason}):`,
          detail,
          `MANDATORY CORRECTION: Call propose_refund ONCE with debitSellerId="${verifiedSellerId}", epoch=${currentEpoch}, checkoutId="${this.state.scenario.checkoutId}", refundAmountKsh=${expectedRefundKsh}, citing [${citedSourceIds.join(", ")}]. After it is accepted, stop and summarize without calling propose_refund again.`,
        ].join("\n"),
        input: updatedInput,
      },
    };
  }

  private haltForHumanReview(
    verdict: Exclude<FinalVerdict, "READY_FOR_HUMAN_APPROVAL" | "CORRECTED_READY_FOR_APPROVAL">,
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
