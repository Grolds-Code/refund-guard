import type {
  ChargebackWebhookRecord,
  DisputeMatchEvaluation,
  ScenarioFixture,
} from "./types.js";

/**
 * Deterministic payment-to-dispute linkage verifier.
 *
 * Security & accounting rules:
 * 1. `CLOSED_WON` and `WITHDRAWN` disputes are inactive and never block checkout.
 * 2. Both `OPEN` and `CLOSED_LOST` disputes are evaluated against payment identity:
 *    - `OPEN` verified match -> `VERIFIED_ACTIVE_MATCH` (block unsafe cross-system refund).
 *    - `CLOSED_LOST` verified match -> `VERIFIED_LOST_DISPUTE` (cardholder already won
 *      chargeback recovery; issuing another refund risks a double-refund).
 * 3. Any explicit conflicting identifier (`paymentSettlementId` != capture settlement ID,
 *    or non-matching checkout reference suffix) prevents automatic verification and routes
 *    partial overlaps to `AMBIGUOUS_MATCH` (operator review).
 * 4. A checkout reference suffix alone (without matching explicit `paymentSettlementId`),
 *    or a short suffix (< 3 chars / not matching the checkout's full trailing token),
 *    never produces a verified match.
 */
export function evaluateDisputeLink(
  scenario: ScenarioFixture,
  dispute: ChargebackWebhookRecord,
): DisputeMatchEvaluation {
  if (dispute.status === "CLOSED_WON" || dispute.status === "WITHDRAWN") {
    return {
      disputeId: dispute.disputeId,
      status: dispute.status,
      matchState: "INACTIVE",
      matchedSignals: [],
      mismatchedSignals: [`status=${dispute.status}`],
      reason: `Dispute ${dispute.disputeId} is ${dispute.status} (resolved in merchant favor / withdrawn), so it does not block refund review for ${scenario.checkoutId}.`,
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
    dispute.cardLast4.trim().length === 4 &&
    dispute.cardLast4.trim() === capture.cardLast4.trim();
  if (cardMatches) {
    matchedSignals.push(`cardLast4=${capture.cardLast4}`);
  } else {
    mismatchedSignals.push(`cardLast4(${dispute.cardLast4}!=${capture.cardLast4})`);
  }

  // Settlement ID check: explicit non-matching settlement ID is a hard conflict.
  const providedSettlementId = dispute.paymentSettlementId?.trim() ?? "";
  const hasExplicitSettlementId = providedSettlementId.length > 0;
  const settlementIdMatches =
    hasExplicitSettlementId && providedSettlementId === capture.settlementId;
  const settlementIdConflicted =
    hasExplicitSettlementId && providedSettlementId !== capture.settlementId;

  if (settlementIdMatches) {
    matchedSignals.push(`settlementId=${capture.settlementId}`);
  } else if (settlementIdConflicted) {
    mismatchedSignals.push(`settlementId(${providedSettlementId}!=${capture.settlementId})`);
  } else {
    mismatchedSignals.push("settlementId(missing)");
  }

  // Checkout reference suffix check: require exact checkout ID or exact full trailing token
  // (>= 3 chars) so a 1-char suffix like "2" cannot match "CHK-402".
  const checkoutTrailingToken =
    scenario.checkoutId.split("-").pop()?.toLowerCase() ?? scenario.checkoutId.toLowerCase();
  const normalizedSuffix = dispute.pspReferenceSuffix.trim().toLowerCase();
  const hasSuffix = normalizedSuffix.length > 0;
  const suffixMatches =
    normalizedSuffix.length >= 3 &&
    (normalizedSuffix === scenario.checkoutId.toLowerCase() ||
      normalizedSuffix === checkoutTrailingToken);
  const suffixConflicted = hasSuffix && !suffixMatches;

  if (suffixMatches) {
    matchedSignals.push(`checkoutSuffix=${dispute.pspReferenceSuffix.trim()}`);
  } else if (suffixConflicted) {
    mismatchedSignals.push(
      `pspRefSuffix(${dispute.pspReferenceSuffix.trim()}!=${checkoutTrailingToken})`,
    );
  }

  const lineAmountMatches = scenario.orderLines.some(
    (line) => line.amountKsh === dispute.amountKsh,
  );
  const amountWithinCapture =
    Number.isInteger(dispute.amountKsh) &&
    dispute.amountKsh > 0 &&
    dispute.amountKsh <= capture.amountKsh;
  const amountMatchesLineOrCapture =
    lineAmountMatches || dispute.amountKsh === capture.amountKsh;

  if (amountMatchesLineOrCapture) {
    matchedSignals.push(`amountKsh=${dispute.amountKsh}`);
  } else if (amountWithinCapture) {
    matchedSignals.push(`amountWithinCapture=${dispute.amountKsh}<=${capture.amountKsh}`);
  } else {
    mismatchedSignals.push(`amountKsh(${dispute.amountKsh}>${capture.amountKsh})`);
  }

  // Verified link requires:
  // - Matching card last-4
  // - Explicit matching paymentSettlementId (no settlement conflict)
  // - No conflicting checkout suffix
  // - Valid disputed amount within original capture
  if (
    cardMatches &&
    settlementIdMatches &&
    !settlementIdConflicted &&
    !suffixConflicted &&
    amountWithinCapture
  ) {
    if (dispute.status === "CLOSED_LOST") {
      return {
        disputeId: dispute.disputeId,
        status: dispute.status,
        matchState: "VERIFIED_LOST_DISPUTE",
        matchedSignals,
        mismatchedSignals,
        reason: `Prior lost dispute ${dispute.disputeId} (${dispute.reasonCode}, CLOSED_LOST) verified against ${capture.settlementId} / ${scenario.checkoutId} via ${matchedSignals.join(", ")}. Cardholder already recovered via chargeback; block additional refund.`,
      };
    }

    return {
      disputeId: dispute.disputeId,
      status: dispute.status,
      matchState: "VERIFIED_ACTIVE_MATCH",
      matchedSignals,
      mismatchedSignals,
      reason: `Active dispute ${dispute.disputeId} (${dispute.reasonCode}) verified against ${capture.settlementId} / ${scenario.checkoutId} via ${matchedSignals.join(", ")}.`,
    };
  }

  // If neither card last-4, settlement ID, nor valid checkout suffix matches,
  // this dispute belongs to a different payment and must not disturb this checkout.
  const anyIdentityOverlap = cardMatches || settlementIdMatches || suffixMatches;
  if (!anyIdentityOverlap) {
    return {
      disputeId: dispute.disputeId,
      status: dispute.status,
      matchState: "UNRELATED",
      matchedSignals,
      mismatchedSignals,
      reason: `Dispute ${dispute.disputeId} does not link to ${scenario.checkoutId} or ${capture.settlementId} (${mismatchedSignals.join(", ")}); ignored as unrelated.`,
    };
  }

  // Partial overlap or conflicting identifiers (e.g., matching suffix with different
  // explicit settlement ID, suffix-only without settlement ID, or card match with wrong ref)
  // requires explicit human verification.
  return {
    disputeId: dispute.disputeId,
    status: dispute.status,
    matchState: "AMBIGUOUS_MATCH",
    matchedSignals,
    mismatchedSignals,
    reason: `Dispute ${dispute.disputeId} (${dispute.status}) has partial or conflicting payment signals for ${scenario.checkoutId} (matched: ${matchedSignals.join(", ") || "none"}; mismatched: ${mismatchedSignals.join(", ")}). Operator verification required before releasing funds.`,
  };
}
