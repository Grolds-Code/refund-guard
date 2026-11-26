import type {
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
 */
export function computeGroundedLedger(
  scenario: ScenarioFixture,
  verdict: FinalVerdict,
  supportedDebitSellerId: SellerId | null,
  sentinelFinding: SentinelFinding | null,
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
  const netBatchTotalKsh = batchGrossKsh - confirmedRefundKsh;

  const draftTotalKsh = scenario.draft.sellerLines.reduce(
    (sum, line) => sum + line.netPayoutKsh,
    0,
  );

  // Determine the exact refund deduction supported by verified evidence
  const refundAmount = scenario.draft.refundAmountKsh;
  const isBlocked =
    verdict === "HOLD_MISSING_EVIDENCE" || verdict === "FROZEN_DISPUTE_COLLISION";

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

    // If blocked (missing evidence or chargeback collision), hold the disputed refund
    // line from payout release rather than guessing which seller absorbs it.
    let supportedDeductionKsh: number;
    if (isBlocked) {
      supportedDeductionKsh = 0;
    } else {
      supportedDeductionKsh = supportedDebitSellerId === sellerId ? refundAmount : 0;
    }

    const supportedNetPayoutKsh = isBlocked
      ? grossSalesKsh - (sellerId === scenario.draft.debitedSellerId ? refundAmount : 0)
      : grossSalesKsh - supportedDeductionKsh;

    // When blocked, we freeze the disputed KSh 10,000 release so neither seller receives
    // unverified funds for the disputed checkout line.
    const finalSupportedNet = isBlocked
      ? grossSalesKsh - checkoutSalesKsh
      : supportedNetPayoutKsh;

    const citations = new Set<string>([
      ...baseCitations,
      ...checkoutLinesForSeller.map((l) => l.lineId),
    ]);
    if (sentinelFinding) {
      for (const id of sentinelFinding.citedSourceIds) {
        citations.add(id);
      }
    }

    return {
      sellerId,
      sellerName: seller.name,
      grossSalesKsh,
      draftDeductionKsh: draftLine.refundDeductionKsh,
      draftNetPayoutKsh: draftLine.netPayoutKsh,
      supportedDeductionKsh: isBlocked ? checkoutSalesKsh : supportedDeductionKsh,
      supportedNetPayoutKsh: finalSupportedNet,
      deltaKsh: finalSupportedNet - draftLine.netPayoutKsh,
      citations: [...citations],
    };
  });

  const supportedTotalKsh = lines.reduce((sum, l) => sum + l.supportedNetPayoutKsh, 0);

  // Zero-sum seller misallocation caught: when draft charged the wrong seller
  // while keeping total payout equal to net batch settlement.
  const misallocationCaughtKsh =
    !isBlocked &&
    supportedDebitSellerId !== null &&
    supportedDebitSellerId !== scenario.draft.debitedSellerId
      ? refundAmount
      : 0;

  // Double payout prevented: when an external bank chargeback already locks the
  // refund amount and RefundGuard halts the duplicate store refund.
  const doublePayoutPreventedKsh =
    verdict === "FROZEN_DISPUTE_COLLISION" ? scenario.ticket.requestedRefundKsh : 0;

  const heldAmountKsh = isBlocked ? Math.max(0, draftTotalKsh - supportedTotalKsh) : 0;

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
    netBatchTotalKsh,
    draftTotalKsh,
    supportedTotalKsh,
    totalStillMatchesExactly: draftTotalKsh === netBatchTotalKsh,
    misallocationCaughtKsh,
    doublePayoutPreventedKsh,
    heldAmountKsh,
    lines,
    allCitations: [...allCitations],
  };
}

export function formatKsh(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}KSh ${Math.abs(amount).toLocaleString("en-KE")}`;
}
