import type {
  DisputeMatchEvaluation,
  FinalVerdict,
  GroundedAllocationLine,
  GroundedLedgerResult,
  ScenarioFixture,
  SellerId,
  SentinelFinding,
} from "./types.js";

const SELLER_IDS: readonly SellerId[] = ["SELLER-A", "SELLER-B"];

/**
 * Pure deterministic financial calculator.
 * Zero floating point, zero LLM arithmetic. Every shilling is derived strictly
 * from immutable source records and carries explicit provenance IDs.
 *
 * Hold Policy:
 * - Approved verdicts (`READY_FOR_HUMAN_APPROVAL`, `CORRECTED_READY_FOR_APPROVAL`):
 *   release full net batch; deduct confirmed refund only from the verified seller.
 * - Active dispute collision (`FROZEN_DISPUTE_COLLISION`) with an identified seller line:
 *   block the unsafe KSh 10,000 cross-system refund proposal and hold only the disputed
 *   seller's checkout line (KSh 10,000) in reserve while leaving the undisputed seller clear.
 * - Missing evidence, ambiguous dispute match, or pending revalidation
 *   (`HOLD_MISSING_EVIDENCE`, `VERIFY_DISPUTE_MATCH`, `PENDING_REVALIDATION`):
 *   seller liability across the checkout is unresolved, so hold both checkout lines
 *   (KSh 20,000 total reserve across Seller A and Seller B) rather than risking paying the
 *   wrong seller. Requested refund amount (KSh 10,000) is always reported separately.
 */
export function computeGroundedLedger(
  scenario: ScenarioFixture,
  verdict: FinalVerdict,
  supportedDebitSellerId: SellerId | null,
  sentinelFinding: SentinelFinding | null,
  disputeEvaluation: DisputeMatchEvaluation | null = null,
): GroundedLedgerResult {
  const captureSettlements = scenario.settlements.filter((s) => s.kind === "CAPTURE");
  const refundSettlements = scenario.settlements.filter((s) => s.kind === "REFUND");

  const checkoutCaptureKsh = captureSettlements.reduce((sum, s) => sum + s.amountKsh, 0);
  const priorBatchGrossKsh = SELLER_IDS.reduce(
    (sum, id) => sum + scenario.priorBatchGrossBySellerKsh[id],
    0,
  );
  const batchGrossKsh = priorBatchGrossKsh + checkoutCaptureKsh;
  const confirmedRefundKsh = refundSettlements.reduce((sum, s) => sum + s.amountKsh, 0);
  const requestedRefundKsh = scenario.ticket.requestedRefundKsh;
  const netBatchTotalKsh = batchGrossKsh - confirmedRefundKsh;

  const draftTotalKsh = scenario.draft.sellerLines.reduce(
    (sum, line) => sum + line.netPayoutKsh,
    0,
  );

  const refundAmount = scenario.draft.refundAmountKsh;
  const isApproved =
    verdict === "READY_FOR_HUMAN_APPROVAL" ||
    verdict === "CORRECTED_READY_FOR_APPROVAL";

  // For a verified active dispute where the disputed seller line is known (e.g., Seller A's
  // jacket), hold only that seller's disputed line (KSh 10,000) rather than both sellers.
  const knownDisputedSellerId: SellerId | null =
    verdict === "FROZEN_DISPUTE_COLLISION"
      ? (sentinelFinding?.verifiedSellerId ?? scenario.draft.debitedSellerId)
      : null;

  const baseCitations = [
    scenario.draft.draftId,
    scenario.ticket.ticketId,
    ...scenario.settlements.map((s) => s.settlementId),
  ];

  const lines: GroundedAllocationLine[] = SELLER_IDS.map((sellerId) => {
    const seller = scenario.sellers[sellerId];
    const checkoutLinesForSeller = scenario.orderLines.filter(
      (line) => line.sellerId === sellerId,
    );
    const checkoutSalesKsh = checkoutLinesForSeller.reduce(
      (sum, line) => sum + line.amountKsh,
      0,
    );
    const grossSalesKsh = scenario.priorBatchGrossBySellerKsh[sellerId] + checkoutSalesKsh;

    const draftLine = scenario.draft.sellerLines.find((l) => l.sellerId === sellerId);
    if (!draftLine) {
      throw new Error(`Missing payout draft line for ${sellerId} in ${scenario.id}`);
    }

    let supportedDeductionKsh: number;
    if (isApproved) {
      supportedDeductionKsh = supportedDebitSellerId === sellerId ? refundAmount : 0;
    } else if (verdict === "FROZEN_DISPUTE_COLLISION" && knownDisputedSellerId !== null) {
      supportedDeductionKsh = sellerId === knownDisputedSellerId ? checkoutSalesKsh : 0;
    } else {
      // Unresolved seller attribution: hold this seller's unsettled checkout line in reserve.
      supportedDeductionKsh = checkoutSalesKsh;
    }

    const supportedNetPayoutKsh = grossSalesKsh - supportedDeductionKsh;

    const citations = new Set<string>([
      ...baseCitations,
      ...checkoutLinesForSeller.map((l) => l.lineId),
    ]);
    if (sentinelFinding) {
      for (const id of sentinelFinding.citedSourceIds) {
        citations.add(id);
      }
    }
    if (
      disputeEvaluation &&
      (disputeEvaluation.matchState === "VERIFIED_ACTIVE_MATCH" ||
        disputeEvaluation.matchState === "AMBIGUOUS_MATCH")
    ) {
      citations.add(disputeEvaluation.disputeId);
    }

    return {
      sellerId,
      sellerName: seller.name,
      grossSalesKsh,
      draftDeductionKsh: draftLine.refundDeductionKsh,
      draftNetPayoutKsh: draftLine.netPayoutKsh,
      supportedDeductionKsh,
      supportedNetPayoutKsh,
      deltaKsh: supportedNetPayoutKsh - draftLine.netPayoutKsh,
      citations: [...citations],
    };
  });

  const supportedTotalKsh = lines.reduce((sum, l) => sum + l.supportedNetPayoutKsh, 0);

  const misallocationCaughtKsh =
    isApproved &&
    supportedDebitSellerId !== null &&
    supportedDebitSellerId !== scenario.draft.debitedSellerId
      ? refundAmount
      : 0;

  const blockedUnsafeRefundKsh =
    verdict === "FROZEN_DISPUTE_COLLISION" ? requestedRefundKsh : 0;

  // Held reserve is the exact portion of checkout capture withheld from payout release.
  const heldReserveKsh = isApproved
    ? 0
    : Math.max(0, batchGrossKsh - confirmedRefundKsh - supportedTotalKsh);

  let holdPolicyExplanation: string;
  if (isApproved) {
    holdPolicyExplanation =
      misallocationCaughtKsh > 0
        ? `Batch total remains ${formatKsh(supportedTotalKsh)}; ${formatKsh(misallocationCaughtKsh)} refund deduction reallocated to verified seller ${supportedDebitSellerId}.`
        : `No reserve held; ${formatKsh(supportedTotalKsh)} cleared for human approval.`;
  } else if (verdict === "FROZEN_DISPUTE_COLLISION" && knownDisputedSellerId) {
    holdPolicyExplanation = `Requested refund blocked: ${formatKsh(requestedRefundKsh)}. Reserve held: ${formatKsh(heldReserveKsh)} (${knownDisputedSellerId}'s disputed checkout line held while active dispute is open; undisputed seller payout remains clear).`;
  } else if (verdict === "VERIFY_DISPUTE_MATCH") {
    holdPolicyExplanation = `Requested refund: ${formatKsh(requestedRefundKsh)}. Reserve held: ${formatKsh(heldReserveKsh)} (both checkout lines held pending operator verification of ambiguous dispute match).`;
  } else if (verdict === "PENDING_REVALIDATION") {
    holdPolicyExplanation = `Requested refund: ${formatKsh(requestedRefundKsh)}. Reserve held: ${formatKsh(heldReserveKsh)} (prior approval invalidated by newer evidence epoch; revalidation pending).`;
  } else {
    holdPolicyExplanation = `Requested refund: ${formatKsh(requestedRefundKsh)}. Reserve held: ${formatKsh(heldReserveKsh)} (unsettled checkout lines held because physical return attribution is unverified).`;
  }

  const allCitations = new Set<string>();
  for (const line of lines) {
    for (const c of line.citations) {
      allCitations.add(c);
    }
  }

  return {
    batchId: scenario.batchId,
    checkoutId: scenario.checkoutId,
    batchGrossKsh,
    confirmedRefundKsh,
    requestedRefundKsh,
    netBatchTotalKsh,
    draftTotalKsh,
    supportedTotalKsh,
    totalStillMatchesExactly: draftTotalKsh === netBatchTotalKsh,
    misallocationCaughtKsh,
    blockedUnsafeRefundKsh,
    heldReserveKsh,
    holdPolicyExplanation,
    lines,
    allCitations: [...allCitations],
  };
}

export function formatKsh(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}KSh ${Math.abs(amount).toLocaleString("en-KE")}`;
}
