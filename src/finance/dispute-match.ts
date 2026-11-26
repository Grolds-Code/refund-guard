import type {
  ChargebackWebhookRecord,
  DisputeMatchEvaluation,
  ScenarioFixture,
} from "./types.js";

/**
 * Deterministic payment-to-dispute linkage verifier.
 *
 * Prevents an unrelated dispute webhook from freezing a clean checkout,
 * distinguishes inactive disputes from active open disputes, and routes
 * partial/conflicting signals to human verification instead of silently
 * assuming a confirmed collision.
 */
export function evaluateDisputeLink(
  scenario: ScenarioFixture,
  dispute: ChargebackWebhookRecord,
): DisputeMatchEvaluation {
  if (dispute.status !== "OPEN") {
    return {
      disputeId: dispute.disputeId,
      status: dispute.status,
      matchState: "INACTIVE",
      matchedSignals: [],
      mismatchedSignals: [`status=${dispute.status}`],
      reason: `Dispute ${dispute.disputeId} is ${dispute.status} (not active), so it does not block refund review for ${scenario.checkoutId}.`,
    };
  }

  const capture = scenario.settlements.find((s) => s.kind === "CAPTURE");
  if (!capture) {
    return {
      disputeId: dispute.disputeId,
      status: dispute.status,
      matchState: "AMBIGUOUS_MATCH",
      matchedSignals: [],
      mismatchedSignals: ["missing_capture_settlement"],
      reason: `No original capture settlement found for ${scenario.checkoutId} to verify dispute ${dispute.disputeId}.`,
    };
  }

  const matchedSignals: string[] = [];
  const mismatchedSignals: string[] = [];

  const cardMatches =
    dispute.cardLast4.trim().length > 0 &&
    dispute.cardLast4.trim() === capture.cardLast4.trim();
  if (cardMatches) {
    matchedSignals.push(`cardLast4=${capture.cardLast4}`);
  } else {
    mismatchedSignals.push(`cardLast4(${dispute.cardLast4}!=${capture.cardLast4})`);
  }

  const settlementIdMatches =
    Boolean(dispute.paymentSettlementId) &&
    dispute.paymentSettlementId === capture.settlementId;
  const suffixMatches =
    dispute.pspReferenceSuffix.trim().length > 0 &&
    scenario.checkoutId.toLowerCase().endsWith(dispute.pspReferenceSuffix.trim().toLowerCase());
  const refMatches = settlementIdMatches || suffixMatches;
  if (settlementIdMatches) {
    matchedSignals.push(`settlementId=${capture.settlementId}`);
  } else if (suffixMatches) {
    matchedSignals.push(`checkoutSuffix=${dispute.pspReferenceSuffix}`);
  } else {
    mismatchedSignals.push(
      `pspRefSuffix(${dispute.pspReferenceSuffix} not in ${scenario.checkoutId})`,
    );
  }

  const lineAmountMatches = scenario.orderLines.some(
    (line) => line.amountKsh === dispute.amountKsh,
  );
  const amountWithinCapture =
    dispute.amountKsh > 0 && dispute.amountKsh <= capture.amountKsh;
  const amountMatchesLineOrCapture =
    lineAmountMatches || dispute.amountKsh === capture.amountKsh;

  if (amountMatchesLineOrCapture) {
    matchedSignals.push(`amountKsh=${dispute.amountKsh}`);
  } else if (amountWithinCapture) {
    matchedSignals.push(`amountWithinCapture=${dispute.amountKsh}<=${capture.amountKsh}`);
  } else {
    mismatchedSignals.push(`amountKsh(${dispute.amountKsh}>${capture.amountKsh})`);
  }

  // Verified active link requires strong payment identity (card + checkout/settlement ref)
  // and a valid disputed amount within the original capture.
  if (cardMatches && refMatches && amountWithinCapture) {
    return {
      disputeId: dispute.disputeId,
      status: dispute.status,
      matchState: "VERIFIED_ACTIVE_MATCH",
      matchedSignals,
      mismatchedSignals,
      reason: `Active dispute ${dispute.disputeId} (${dispute.reasonCode}) verified against ${capture.settlementId} / ${scenario.checkoutId} via ${matchedSignals.join(", ")}.`,
    };
  }

  // If neither card last-4 nor checkout/settlement reference matches, this dispute
  // belongs to a different payment and must not block this checkout.
  if (!cardMatches && !refMatches) {
    return {
      disputeId: dispute.disputeId,
      status: dispute.status,
      matchState: "UNRELATED",
      matchedSignals,
      mismatchedSignals,
      reason: `Dispute ${dispute.disputeId} does not link to ${scenario.checkoutId} or ${capture.settlementId} (${mismatchedSignals.join(", ")}); ignored as unrelated.`,
    };
  }

  // Partial overlap (e.g., matching card but mismatched checkout suffix, or matching ref
  // with mismatched card/excess amount) requires human verification.
  return {
    disputeId: dispute.disputeId,
    status: dispute.status,
    matchState: "AMBIGUOUS_MATCH",
    matchedSignals,
    mismatchedSignals,
    reason: `Dispute ${dispute.disputeId} has partial overlap with ${scenario.checkoutId} (matched: ${matchedSignals.join(", ") || "none"}; mismatched: ${mismatchedSignals.join(", ")}). Operator verification required before releasing funds.`,
  };
}
