import {
  isVerdictApprovable,
  type DisputeMatchEvaluation,
  type FinalVerdict,
  type GroundedAllocationLine,
  type GroundedLedgerResult,
  type ScenarioFixture,
  type SellerId,
  type SentinelFinding,
} from "./types.js";

const SELLER_IDS: readonly SellerId[] = ["SELLER-A", "SELLER-B"];

export interface MoneyReconciliationCheck {
  readonly ok: boolean;
  readonly expectedRefundKsh: number;
  readonly confirmedRefundKsh: number;
  readonly netBatchTotalKsh: number;
  readonly draftTotalKsh: number;
  readonly error: string | null;
}

/**
 * Deterministic pre-clearance money reconciliation check.
 * Ensures the draft refund amount, seller draft lines, posted processor refund
 * settlement (when present), and proposed refund amount reconcile to the shilling.
 */
export function checkMoneyReconciliation(
  scenario: ScenarioFixture,
  proposedRefundAmountKsh?: number,
): MoneyReconciliationCheck {
  const captureSettlements = scenario.settlements.filter((s) => s.kind === "CAPTURE");
  const refundSettlements = scenario.settlements.filter((s) => s.kind === "REFUND");

  const checkoutCaptureKsh = captureSettlements.reduce((sum, s) => sum + s.amountKsh, 0);
  const priorBatchGrossKsh = SELLER_IDS.reduce(
    (sum, id) => sum + scenario.priorBatchGrossBySellerKsh[id],
    0,
  );
  const batchGrossKsh = priorBatchGrossKsh + checkoutCaptureKsh;
  const confirmedRefundKsh = refundSettlements.reduce((sum, s) => sum + s.amountKsh, 0);
  const netBatchTotalKsh = batchGrossKsh - confirmedRefundKsh;
  const draftTotalKsh = scenario.draft.sellerLines.reduce(
    (sum, line) => sum + line.netPayoutKsh,
    0,
  );
  const draftDeductionTotalKsh = scenario.draft.sellerLines.reduce(
    (sum, line) => sum + line.refundDeductionKsh,
    0,
  );
  const expectedRefundKsh =
    confirmedRefundKsh > 0 ? confirmedRefundKsh : scenario.ticket.requestedRefundKsh;

  const errors: string[] = [];

  if (!Number.isInteger(scenario.draft.refundAmountKsh) || scenario.draft.refundAmountKsh <= 0) {
    errors.push(`Draft refund amount (${scenario.draft.refundAmountKsh}) must be a positive integer.`);
  }

  if (scenario.draft.refundAmountKsh > checkoutCaptureKsh) {
    errors.push(
      `Draft refund (${formatKsh(scenario.draft.refundAmountKsh)}) exceeds checkout capture (${formatKsh(checkoutCaptureKsh)}).`,
    );
  }

  // Verify internal draft line arithmetic
  for (const sellerId of SELLER_IDS) {
    const line = scenario.draft.sellerLines.find((l) => l.sellerId === sellerId);
    if (!line) {
      errors.push(`Missing payout draft line for ${sellerId}.`);
      continue;
    }
    const checkoutSalesKsh = scenario.orderLines
      .filter((ol) => ol.sellerId === sellerId)
      .reduce((sum, ol) => sum + ol.amountKsh, 0);
    const expectedGrossKsh = scenario.priorBatchGrossBySellerKsh[sellerId] + checkoutSalesKsh;
    if (line.grossSalesKsh !== expectedGrossKsh) {
      errors.push(
        `Draft gross for ${sellerId} (${formatKsh(line.grossSalesKsh)}) != source gross (${formatKsh(expectedGrossKsh)}).`,
      );
    }
    if (line.grossSalesKsh - line.refundDeductionKsh !== line.netPayoutKsh) {
      errors.push(
        `Draft net payout arithmetic mismatch for ${sellerId} (${formatKsh(line.grossSalesKsh)} - ${formatKsh(line.refundDeductionKsh)} != ${formatKsh(line.netPayoutKsh)}).`,
      );
    }
  }

  if (confirmedRefundKsh > 0) {
    if (scenario.draft.refundAmountKsh !== confirmedRefundKsh) {
      errors.push(
        `Draft refund (${formatKsh(scenario.draft.refundAmountKsh)}) does not match posted settlement refund (${formatKsh(confirmedRefundKsh)}).`,
      );
    }
    if (draftDeductionTotalKsh !== confirmedRefundKsh) {
      errors.push(
        `Draft seller deductions (${formatKsh(draftDeductionTotalKsh)}) do not match posted settlement refund (${formatKsh(confirmedRefundKsh)}).`,
      );
    }
    if (draftTotalKsh !== netBatchTotalKsh) {
      errors.push(
        `Draft payable total (${formatKsh(draftTotalKsh)}) does not reconcile with posted net settlement (${formatKsh(netBatchTotalKsh)}).`,
      );
    }
  } else {
    if (scenario.draft.refundAmountKsh !== scenario.ticket.requestedRefundKsh) {
      errors.push(
        `Draft refund (${formatKsh(scenario.draft.refundAmountKsh)}) does not match ticket requested refund (${formatKsh(scenario.ticket.requestedRefundKsh)}).`,
      );
    }
  }

  if (
    proposedRefundAmountKsh !== undefined &&
    proposedRefundAmountKsh !== expectedRefundKsh
  ) {
    errors.push(
      `Proposed refund (${formatKsh(proposedRefundAmountKsh)}) does not match expected settlement refund (${formatKsh(expectedRefundKsh)}).`,
    );
  }

  return {
    ok: errors.length === 0,
    expectedRefundKsh,
    confirmedRefundKsh,
    netBatchTotalKsh,
    draftTotalKsh,
    error: errors.length > 0 ? errors.join(" ") : null,
  };
}

/**
 * Pure deterministic financial calculator.
 * Zero floating point, zero LLM arithmetic. Every shilling is derived strictly
 * from immutable source records and carries explicit provenance IDs.
 *
 * Hold Policy:
 * - Approved verdicts (`READY_FOR_HUMAN_APPROVAL`, `CORRECTED_READY_FOR_APPROVAL`):
 *   release full reconciled net batch; deduct confirmed refund only from the verified seller.
 * - Dispute collision (`FROZEN_DISPUTE_COLLISION`) with a HIGH-confidence verified seller line:
 *   block the unsafe cross-system refund proposal and hold the verified disputed seller's
 *   checkout line (plus any already-posted refund deduction) in reserve while leaving the
 *   undisputed seller clear. Never falls back to the untrusted draft seller when evidence
 *   is missing or unverified.
 * - Missing evidence, reconciliation mismatch, ambiguous dispute match, pending revalidation,
 *   or dispute collision without a verified returned seller:
 *   withhold both checkout lines from gross seller payouts rather than guessing which seller
 *   absorbs liability. `totalWithheldFromGrossKsh` reports total checkout sales withheld from
 *   sellers; `heldReserveKsh` reports the cash reserve held out of `netBatchTotalKsh`
 *   (net settlement after any posted processor refund).
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

  const recon = checkMoneyReconciliation(scenario);
  const refundAmount = confirmedRefundKsh > 0 ? confirmedRefundKsh : scenario.draft.refundAmountKsh;
  const isApproved = isVerdictApprovable(verdict);

  // Only attribute a single-seller dispute reserve when Sentinel verified the specific
  // returned seller & line with HIGH confidence. Never fall back to the untrusted draft.
  const verifiedDisputedSellerId: SellerId | null =
    verdict === "FROZEN_DISPUTE_COLLISION" &&
    sentinelFinding !== null &&
    sentinelFinding.confidence === "HIGH" &&
    sentinelFinding.verifiedSellerId !== null &&
    scenario.orderLines.some(
      (ol) =>
        ol.sellerId === sentinelFinding.verifiedSellerId &&
        (sentinelFinding.verifiedLineId === null ||
          ol.lineId === sentinelFinding.verifiedLineId),
    )
      ? sentinelFinding.verifiedSellerId
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
    } else if (verdict === "FROZEN_DISPUTE_COLLISION" && verifiedDisputedSellerId !== null) {
      // Hold the verified disputed seller's checkout line, plus any already-posted refund
      // against that same seller so active/lost dispute reserve never collapses to KSh 0.
      supportedDeductionKsh =
        sellerId === verifiedDisputedSellerId
          ? Math.min(grossSalesKsh, checkoutSalesKsh + confirmedRefundKsh)
          : 0;
    } else {
      // Unresolved attribution or reconciliation mismatch: withhold this seller's
      // checkout line from gross payout rather than guessing liability.
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
        disputeEvaluation.matchState === "VERIFIED_LOST_DISPUTE" ||
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

  const totalWithheldFromGrossKsh = Math.max(0, batchGrossKsh - supportedTotalKsh);
  // Cash reserve held out of the net bank settlement (`netBatchTotalKsh`), separate from
  // any processor refund already deducted by the PSP (`confirmedRefundKsh`).
  const heldReserveKsh = isApproved
    ? 0
    : Math.max(0, netBatchTotalKsh - supportedTotalKsh);

  let holdPolicyExplanation: string;
  if (isApproved) {
    holdPolicyExplanation =
      misallocationCaughtKsh > 0
        ? `Batch total remains ${formatKsh(supportedTotalKsh)}; ${formatKsh(misallocationCaughtKsh)} refund deduction reallocated to verified seller ${supportedDebitSellerId}.`
        : `No reserve held; ${formatKsh(supportedTotalKsh)} cleared for human approval.`;
  } else if (verdict === "HOLD_RECONCILIATION_MISMATCH") {
    holdPolicyExplanation = `Reconciliation mismatch blocked clearance: ${recon.error ?? "draft and posted settlement totals do not match"}. Gross checkout lines withheld: ${formatKsh(totalWithheldFromGrossKsh)} (cash reserve held from net settlement: ${formatKsh(heldReserveKsh)}).`;
  } else if (verdict === "FROZEN_DISPUTE_COLLISION" && verifiedDisputedSellerId) {
    const disputeKind =
      disputeEvaluation?.matchState === "VERIFIED_LOST_DISPUTE"
        ? "prior lost chargeback (CLOSED_LOST)"
        : "active dispute";
    holdPolicyExplanation = `Requested refund blocked: ${formatKsh(requestedRefundKsh)}. Reserve held: ${formatKsh(heldReserveKsh)} (${verifiedDisputedSellerId}'s verified disputed line held due to ${disputeKind}; undisputed seller payout remains clear).`;
  } else if (verdict === "FROZEN_DISPUTE_COLLISION") {
    holdPolicyExplanation = `Requested refund blocked: ${formatKsh(requestedRefundKsh)}. Gross checkout lines withheld: ${formatKsh(totalWithheldFromGrossKsh)} (cash reserve held from net settlement: ${formatKsh(heldReserveKsh)}; disputed seller line unverified so both checkout lines are held without guessing from the draft).`;
  } else if (verdict === "VERIFY_DISPUTE_MATCH") {
    holdPolicyExplanation = `Requested refund: ${formatKsh(requestedRefundKsh)}. Gross checkout lines withheld: ${formatKsh(totalWithheldFromGrossKsh)} (cash reserve held from net settlement: ${formatKsh(heldReserveKsh)}; both checkout lines held pending operator verification of ambiguous dispute match).`;
  } else if (verdict === "PENDING_REVALIDATION") {
    holdPolicyExplanation = `Requested refund: ${formatKsh(requestedRefundKsh)}. Gross checkout lines withheld: ${formatKsh(totalWithheldFromGrossKsh)} (cash reserve held from net settlement: ${formatKsh(heldReserveKsh)}; prior approval invalidated by newer evidence epoch).`;
  } else {
    holdPolicyExplanation = `Requested refund: ${formatKsh(requestedRefundKsh)}. Gross checkout lines withheld: ${formatKsh(totalWithheldFromGrossKsh)} (cash reserve held from net settlement: ${formatKsh(heldReserveKsh)}; both checkout lines held because physical return attribution is unverified).`;
  }

  const allCitations = new Set<string>();
  for (const line of lines) {
    for (const c of line.citations) {
      allCitations.add(c);
    }
  }

  const approvedReconcilesWithNet =
    !isApproved ||
    (confirmedRefundKsh > 0
      ? supportedTotalKsh === netBatchTotalKsh
      : supportedTotalKsh === batchGrossKsh - refundAmount);

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
    reconciliationMatched: recon.ok && approvedReconcilesWithNet,
    reconciliationError: recon.error,
    misallocationCaughtKsh,
    blockedUnsafeRefundKsh,
    totalWithheldFromGrossKsh,
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
