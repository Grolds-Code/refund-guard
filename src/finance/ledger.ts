import {
  isVerdictApprovable,
  type DisputeMatchEvaluation,
  type FinalVerdict,
  type GroundedAllocationLine,
  type GroundedLedgerResult,
  type ScenarioFixture,
  type SellerId,
  type SentinelFinding,
  type SettlementRecord,
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

function deduplicateSettlements(settlements: readonly SettlementRecord[]): {
  unique: SettlementRecord[];
  duplicateIds: string[];
} {
  const seen = new Set<string>();
  const unique: SettlementRecord[] = [];
  const duplicateIds: string[] = [];
  for (const st of settlements) {
    if (seen.has(st.settlementId)) {
      duplicateIds.push(st.settlementId);
      continue;
    }
    seen.add(st.settlementId);
    unique.push(st);
  }
  return { unique, duplicateIds };
}

/**
 * Deterministic pre-clearance money reconciliation check.
 * Enforces:
 * - Each settlementId is counted at most once (duplicate settlement IDs fail closed).
 * - Draft refund, ticket requested refund, posted processor refund (when present),
 *   draft seller deductions (including explicit 0-deduction not-yet-applied drafts),
 *   and proposed refund amount all reconcile cleanly.
 * - When a verified returned order line is known, refund amount cannot exceed that
 *   verified line's refundable amount.
 */
export function checkMoneyReconciliation(
  scenario: ScenarioFixture,
  proposedRefundAmountKsh?: number,
  verifiedLineId?: string | null,
): MoneyReconciliationCheck {
  const { unique: uniqueSettlements, duplicateIds } = deduplicateSettlements(
    scenario.settlements,
  );
  const captureSettlements = uniqueSettlements.filter((s) => s.kind === "CAPTURE");
  const refundSettlements = uniqueSettlements.filter((s) => s.kind === "REFUND");

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

  if (duplicateIds.length > 0) {
    errors.push(
      `Duplicate settlement record ID(s) detected: ${Array.from(new Set(duplicateIds)).join(", ")}.`,
    );
  }

  if (!Number.isInteger(scenario.draft.refundAmountKsh) || scenario.draft.refundAmountKsh <= 0) {
    errors.push(
      `Draft refund amount (${scenario.draft.refundAmountKsh}) must be a positive integer.`,
    );
  }

  if (
    !Number.isInteger(scenario.ticket.requestedRefundKsh) ||
    scenario.ticket.requestedRefundKsh <= 0
  ) {
    errors.push(
      `Ticket requested refund (${scenario.ticket.requestedRefundKsh}) must be a positive integer.`,
    );
  }

  if (scenario.draft.refundAmountKsh > checkoutCaptureKsh) {
    errors.push(
      `Draft refund (${formatKsh(scenario.draft.refundAmountKsh)}) exceeds checkout capture (${formatKsh(checkoutCaptureKsh)}).`,
    );
  }

  // Flag unexplained differences between customer ticket requested refund and draft/posted refund.
  if (scenario.ticket.requestedRefundKsh !== scenario.draft.refundAmountKsh) {
    errors.push(
      `Ticket requested refund (${formatKsh(scenario.ticket.requestedRefundKsh)}) does not match draft refund (${formatKsh(scenario.draft.refundAmountKsh)}).`,
    );
  }

  // Verify internal draft line arithmetic and deduction bounds
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
    if (
      !Number.isInteger(line.refundDeductionKsh) ||
      line.refundDeductionKsh < 0 ||
      line.refundDeductionKsh > line.grossSalesKsh
    ) {
      errors.push(
        `Draft deduction for ${sellerId} (${formatKsh(line.refundDeductionKsh)}) is out of valid bounds.`,
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
    if (scenario.ticket.requestedRefundKsh !== confirmedRefundKsh) {
      errors.push(
        `Ticket requested refund (${formatKsh(scenario.ticket.requestedRefundKsh)}) does not match posted settlement refund (${formatKsh(confirmedRefundKsh)}).`,
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
    // When no processor refund has posted yet, draft seller deductions must be either
    // explicitly 0 (not-yet-applied draft) or exactly equal to draft.refundAmountKsh.
    if (
      draftDeductionTotalKsh !== 0 &&
      draftDeductionTotalKsh !== scenario.draft.refundAmountKsh
    ) {
      errors.push(
        `Draft seller deductions (${formatKsh(draftDeductionTotalKsh)}) do not match pending refund (${formatKsh(scenario.draft.refundAmountKsh)}) or an unapplied zero-deduction draft.`,
      );
    }
    const expectedDraftTotalKsh = batchGrossKsh - draftDeductionTotalKsh;
    if (draftTotalKsh !== expectedDraftTotalKsh) {
      errors.push(
        `Draft payable total (${formatKsh(draftTotalKsh)}) does not equal batch gross minus draft deductions (${formatKsh(expectedDraftTotalKsh)}).`,
      );
    }
  }

  // Cap refund against the verified returned order line's refundable amount.
  if (verifiedLineId) {
    const verifiedLine = scenario.orderLines.find((ol) => ol.lineId === verifiedLineId);
    if (!verifiedLine) {
      errors.push(`Verified line ${verifiedLineId} not found in orderLines.`);
    } else if (expectedRefundKsh > verifiedLine.amountKsh) {
      errors.push(
        `Refund amount (${formatKsh(expectedRefundKsh)}) exceeds verified returned line ${verifiedLine.lineId} refundable amount (${formatKsh(verifiedLine.amountKsh)}).`,
      );
    } else if (scenario.draft.refundAmountKsh > verifiedLine.amountKsh) {
      errors.push(
        `Draft refund (${formatKsh(scenario.draft.refundAmountKsh)}) exceeds verified returned line ${verifiedLine.lineId} refundable amount (${formatKsh(verifiedLine.amountKsh)}).`,
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
 * from deduplicated immutable source records and carries explicit provenance IDs.
 */
export function computeGroundedLedger(
  scenario: ScenarioFixture,
  verdict: FinalVerdict,
  supportedDebitSellerId: SellerId | null,
  sentinelFinding: SentinelFinding | null,
  disputeEvaluation: DisputeMatchEvaluation | null = null,
  activeDisputeAmountKsh: number | null = null,
  latestWarehouseNoteId: string = scenario.initialWarehouseNote.noteId,
): GroundedLedgerResult {
  const { unique: uniqueSettlements } = deduplicateSettlements(scenario.settlements);
  const captureSettlements = uniqueSettlements.filter((s) => s.kind === "CAPTURE");
  const refundSettlements = uniqueSettlements.filter((s) => s.kind === "REFUND");

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

  const recon = checkMoneyReconciliation(
    scenario,
    undefined,
    sentinelFinding?.status === "VERIFIED_RETURN" ? sentinelFinding.verifiedLineId : null,
  );
  const refundAmount =
    confirmedRefundKsh > 0 ? confirmedRefundKsh : scenario.draft.refundAmountKsh;
  const isApproved = isVerdictApprovable(verdict);

  // Only attribute a single-seller dispute reserve when:
  // 1) Sentinel verified the specific returned seller & line with HIGH confidence,
  // 2) The finding was computed from the CURRENT latest warehouse note (never obsolete), AND
  // 3) The disputed amount does NOT exceed that seller's checkout line.
  const findingMatchesLatestNote =
    sentinelFinding !== null && sentinelFinding.evidenceNoteId === latestWarehouseNoteId;
  let verifiedDisputedSellerId: SellerId | null = null;
  let verifiedDisputedSellerLineKsh = 0;
  if (
    verdict === "FROZEN_DISPUTE_COLLISION" &&
    findingMatchesLatestNote &&
    sentinelFinding !== null &&
    sentinelFinding.confidence === "HIGH" &&
    sentinelFinding.verifiedSellerId !== null
  ) {
    const sellerLine = scenario.orderLines.find(
      (ol) =>
        ol.sellerId === sentinelFinding.verifiedSellerId &&
        (sentinelFinding.verifiedLineId === null ||
          ol.lineId === sentinelFinding.verifiedLineId),
    );
    if (sellerLine) {
      const sellerCheckoutSalesKsh = scenario.orderLines
        .filter((ol) => ol.sellerId === sellerLine.sellerId)
        .reduce((sum, ol) => sum + ol.amountKsh, 0);
      const effectiveDisputeAmt = activeDisputeAmountKsh ?? sellerCheckoutSalesKsh;
      if (effectiveDisputeAmt <= sellerCheckoutSalesKsh) {
        verifiedDisputedSellerId = sellerLine.sellerId;
        verifiedDisputedSellerLineKsh = effectiveDisputeAmt;
      }
    }
  }

  const baseCitations = [
    scenario.draft.draftId,
    scenario.ticket.ticketId,
    ...uniqueSettlements.map((s) => s.settlementId),
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
      // Reserve the exact verified dispute amount (plus any already-posted refund against
      // that seller so active/lost dispute exposure never collapses to KSh 0).
      supportedDeductionKsh =
        sellerId === verifiedDisputedSellerId
          ? Math.min(grossSalesKsh, verifiedDisputedSellerLineKsh + confirmedRefundKsh)
          : 0;
    } else {
      // Unresolved seller attribution, checkout-wide dispute, or reconciliation mismatch:
      // withhold this seller's checkout line from gross payout rather than guessing liability.
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

  const pendingRefundKsh = isApproved && confirmedRefundKsh === 0 ? refundAmount : 0;

  const totalWithheldFromGrossKsh = Math.max(0, batchGrossKsh - supportedTotalKsh);
  // Cash reserve held out of net bank settlement (`netBatchTotalKsh`), separate from
  // any processor refund already deducted by the PSP (`confirmedRefundKsh`).
  const heldReserveKsh = isApproved
    ? 0
    : Math.max(0, netBatchTotalKsh - supportedTotalKsh);

  let holdPolicyExplanation: string;
  if (isApproved) {
    if (pendingRefundKsh > 0) {
      holdPolicyExplanation = `No reserve held; ${formatKsh(supportedTotalKsh)} cleared for human approval (${formatKsh(pendingRefundKsh)} pending refund deduction against ${formatKsh(netBatchTotalKsh)} posted net settlement; debited to verified seller ${supportedDebitSellerId}).`;
    } else if (misallocationCaughtKsh > 0) {
      holdPolicyExplanation = `Batch total remains ${formatKsh(supportedTotalKsh)}; ${formatKsh(misallocationCaughtKsh)} refund deduction reallocated to verified seller ${supportedDebitSellerId}.`;
    } else {
      holdPolicyExplanation = `No reserve held; ${formatKsh(supportedTotalKsh)} cleared for human approval.`;
    }
  } else if (verdict === "HOLD_RECONCILIATION_MISMATCH") {
    holdPolicyExplanation = `Reconciliation mismatch blocked clearance: ${recon.error ?? "draft, line, and posted settlement totals do not match"}. Gross checkout lines withheld: ${formatKsh(totalWithheldFromGrossKsh)} (cash reserve held from net settlement: ${formatKsh(heldReserveKsh)}).`;
  } else if (verdict === "FROZEN_DISPUTE_COLLISION" && verifiedDisputedSellerId) {
    const disputeKind =
      disputeEvaluation?.matchState === "VERIFIED_LOST_DISPUTE"
        ? "prior lost chargeback (CLOSED_LOST)"
        : "active dispute";
    holdPolicyExplanation = `Requested refund blocked: ${formatKsh(requestedRefundKsh)}. Reserve held: ${formatKsh(heldReserveKsh)} (${verifiedDisputedSellerId}'s verified disputed exposure of ${formatKsh(verifiedDisputedSellerLineKsh)} held due to ${disputeKind}; undisputed seller payout remains clear).`;
  } else if (verdict === "FROZEN_DISPUTE_COLLISION") {
    const checkoutWide =
      activeDisputeAmountKsh !== null &&
      sentinelFinding?.verifiedSellerId !== null &&
      sentinelFinding?.confidence === "HIGH";
    holdPolicyExplanation = checkoutWide
      ? `Requested refund blocked: ${formatKsh(requestedRefundKsh)}. Checkout-wide dispute (${formatKsh(activeDisputeAmountKsh)}) exceeds a single seller line; holding both checkout lines (${formatKsh(totalWithheldFromGrossKsh)} withheld, ${formatKsh(heldReserveKsh)} cash reserve) for allocation review.`
      : `Requested refund blocked: ${formatKsh(requestedRefundKsh)}. Gross checkout lines withheld: ${formatKsh(totalWithheldFromGrossKsh)} (cash reserve held from net settlement: ${formatKsh(heldReserveKsh)}; disputed seller line unverified so both checkout lines are held without guessing from the draft).`;
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
    pendingRefundKsh,
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
