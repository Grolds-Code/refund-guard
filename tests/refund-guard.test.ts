import {
  createHuman,
  FunctionCallItem,
  ModelContext,
  SemanticEvent,
  UserMessageItem,
  type ExecutableTransition,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
} from "@mozaik-ai/core";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { evaluateDisputeLink } from "../src/finance/dispute-match.js";
import {
  createAmbiguousDisputeFixture,
  createUnrelatedDisputeFixture,
  getScenarioById,
} from "../src/finance/fixtures.js";
import { computeGroundedLedger } from "../src/finance/ledger.js";
import type { ChargebackWebhookRecord, ScenarioFixture, SentinelFinding } from "../src/finance/types.js";
import {
  runSingleAgentSnapshotBaseline,
  runTicketAndDraftBaseline,
} from "../src/engine/baseline.js";
import { runBlackFridayBatch } from "../src/engine/run-batch.js";
import {
  buildInjectedChargeback,
  buildInjectedWarehouseCorrection,
  runRefundGuardCase,
  type PostAcceptanceInjector,
} from "../src/engine/run-case.js";
import { createAuditObserver } from "../src/mozaik/agents/observer.js";
import { createRefundDeskAgent } from "../src/mozaik/agents/refund-desk.js";
import { createSentinelAgent } from "../src/mozaik/agents/sentinel.js";
import { RefundInterceptionGate } from "../src/mozaik/interception.js";
import {
  MOCK_MODEL_NAME,
  RefundGuardMockRunner,
  resolveInferenceMode,
} from "../src/mozaik/runner.js";
import { createRefundGuardRuntime, RefundGuardState } from "../src/mozaik/runtime.js";
import { createRefundGuardServer } from "../src/server.js";

function makeDirectProposalTransition(args: Record<string, unknown>): ExecutableTransition {
  const call = FunctionCallItem.rehydrate({
    callId: `call_test_${Math.random().toString(36).slice(2, 8)}`,
    name: "propose_refund",
    args: JSON.stringify(args),
  });
  const inferenceInput: InferenceInput = {
    model: "refund-guard-deterministic-v1",
    context: ModelContext.create(),
    tools: [],
  };
  return {
    nextStateId: "function_call",
    input: {
      call,
      inferenceInput,
    },
  } as ExecutableTransition;
}

describe("RefundGuard: Concurrent Mozaik Interception Suite", () => {
  it("Case 1: clears a verified allocation cleanly (A: KSh 50,000 / B: KSh 40,000, Total KSh 90,000)", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.4,
    });

    expect(report.verdict).toBe("READY_FOR_HUMAN_APPROVAL");
    expect(report.concurrentOverlapVerified).toBe(true);
    expect(report.interceptions).toHaveLength(0);
    expect(report.acceptedProposal?.debitSellerId).toBe("SELLER-A");
    expect(report.acceptedProposal?.epoch).toBe(report.finalEpoch);
    expect(report.ledger.reconciliationMatched).toBe(true);

    const sellerA = report.ledger.lines.find((l) => l.sellerId === "SELLER-A")!;
    const sellerB = report.ledger.lines.find((l) => l.sellerId === "SELLER-B")!;
    expect(sellerA.supportedNetPayoutKsh).toBe(50_000);
    expect(sellerB.supportedNetPayoutKsh).toBe(40_000);
    expect(report.ledger.supportedTotalKsh).toBe(90_000);
    expect(report.ledger.heldReserveKsh).toBe(0);
    expect(report.ledger.allCitations).toContain("WH-101");
    expect(report.ledger.allCitations).toContain("STL-REF-402");
  });

  it("Case 2: catches a wrong-seller zero-sum allocation with the exact same KSh 90,000 total", async () => {
    const scenario = getScenarioById("case-2-wrong-seller-zerosum");
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.4,
    });

    expect(report.verdict).toBe("CORRECTED_READY_FOR_APPROVAL");
    expect(report.concurrentOverlapVerified).toBe(true);
    expect(report.interceptions.some((i) => i.reason === "WRONG_SELLER_ALLOCATION")).toBe(true);
    expect(report.acceptedProposal?.debitSellerId).toBe("SELLER-A");

    const sellerA = report.ledger.lines.find((l) => l.sellerId === "SELLER-A")!;
    const sellerB = report.ledger.lines.find((l) => l.sellerId === "SELLER-B")!;
    expect(report.ledger.totalStillMatchesExactly).toBe(true);
    expect(report.ledger.reconciliationMatched).toBe(true);
    expect(sellerA.draftNetPayoutKsh).toBe(60_000);
    expect(sellerB.draftNetPayoutKsh).toBe(30_000);
    expect(sellerA.supportedNetPayoutKsh).toBe(50_000);
    expect(sellerB.supportedNetPayoutKsh).toBe(40_000);
    expect(report.ledger.supportedTotalKsh).toBe(90_000);
    expect(report.ledger.misallocationCaughtKsh).toBe(10_000);
  });

  it("Case 3: fails closed when warehouse evidence is missing and separates requested refund from reserve held", async () => {
    const scenario = getScenarioById("case-3-missing-evidence");
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.4,
    });

    expect(report.verdict).toBe("HOLD_MISSING_EVIDENCE");
    expect(report.concurrentOverlapVerified).toBe(true);
    expect(report.acceptedProposal).toBeNull();
    expect(report.interceptions.some((i) => i.reason === "MISSING_EVIDENCE")).toBe(true);
    expect(report.ledger.requestedRefundKsh).toBe(10_000);
    expect(report.ledger.totalWithheldFromGrossKsh).toBe(20_000);
    expect(report.ledger.heldReserveKsh).toBe(10_000);
    expect(report.ledger.holdPolicyExplanation).toContain("Requested refund");
  });

  it("Case 4: rejects superseded epoch-1 proposal when a late warehouse correction arrives mid-flight", async () => {
    const scenario = getScenarioById("case-4-late-correction-midflight");
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.5,
    });

    expect(report.finalEpoch).toBe(2);
    expect(report.verdict).toBe("CORRECTED_READY_FOR_APPROVAL");
    expect(report.concurrentOverlapVerified).toBe(true);
    expect(report.interceptions.some((i) => i.reason === "SUPERSEDED_EVIDENCE")).toBe(true);
    expect(report.acceptedProposal?.debitSellerId).toBe("SELLER-A");
    expect(report.acceptedProposal?.epoch).toBe(2);

    const sellerA = report.ledger.lines.find((l) => l.sellerId === "SELLER-A")!;
    const sellerB = report.ledger.lines.find((l) => l.sellerId === "SELLER-B")!;
    expect(sellerA.supportedNetPayoutKsh).toBe(50_000);
    expect(sellerB.supportedNetPayoutKsh).toBe(40_000);
    expect(report.ledger.allCitations).toContain("WH-404-V2");
  });

  it("Case 5: blocks an unsafe cross-system refund when a verified active dispute collides mid-flight", async () => {
    const scenario = getScenarioById("case-5-chargeback-collision");
    const [snapshotBaseline, guard] = await Promise.all([
      runSingleAgentSnapshotBaseline(scenario, { modeOverride: "mock", latencyScale: 0.5 }),
      runRefundGuardCase(scenario, { modeOverride: "mock", latencyScale: 0.5 }),
    ]);

    expect(snapshotBaseline.verdict).toBe("READY_FOR_HUMAN_APPROVAL");
    expect(snapshotBaseline.acceptedProposal?.debitSellerId).toBe("SELLER-A");

    expect(guard.finalEpoch).toBe(2);
    expect(guard.verdict).toBe("FROZEN_DISPUTE_COLLISION");
    expect(guard.concurrentOverlapVerified).toBe(true);
    expect(guard.acceptedProposal).toBeNull();
    expect(
      guard.interceptions.some((i) => i.reason === "UNSAFE_CROSS_SYSTEM_REFUND_BLOCKED"),
    ).toBe(true);
    expect(guard.disputeEvaluation?.matchState).toBe("VERIFIED_ACTIVE_MATCH");
    expect(guard.ledger.requestedRefundKsh).toBe(10_000);
    expect(guard.ledger.blockedUnsafeRefundKsh).toBe(10_000);
    expect(guard.ledger.heldReserveKsh).toBe(10_000);
    expect(guard.ledger.allCitations).toContain("DSP-505");
  });

  it("Interactive input flip: editing the warehouse note from Jacket (Seller A) to Boots (Seller B) flips the verdict live", async () => {
    const scenario = getScenarioById("case-2-wrong-seller-zerosum");
    const flipped = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.4,
      customWarehouseNoteText:
        "Kisumu Hub intake: confirmed return of 1x Tan Leather Chelsea Boots (SKU BTS-TAN-42, Rift Valley Footwear). Jacket was NOT returned.",
    });

    expect(flipped.verdict).toBe("READY_FOR_HUMAN_APPROVAL");
    expect(flipped.interceptions).toHaveLength(0);
    expect(flipped.acceptedProposal?.debitSellerId).toBe("SELLER-B");
    const sellerA = flipped.ledger.lines.find((l) => l.sellerId === "SELLER-A")!;
    const sellerB = flipped.ledger.lines.find((l) => l.sellerId === "SELLER-B")!;
    expect(sellerA.supportedNetPayoutKsh).toBe(60_000);
    expect(sellerB.supportedNetPayoutKsh).toBe(30_000);
  });

  // --- Post-Acceptance Invalidation Regressions ---

  it("Regression 1A: post-acceptance warehouse correction invalidates epoch-1 Seller A and revalidates to epoch-2 Seller B", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.35,
      onProposalAccepted: ({ injectWarehouseCorrection }) => {
        injectWarehouseCorrection(buildInjectedWarehouseCorrection(scenario, "SELLER-B"));
      },
    });

    expect(report.finalEpoch).toBe(2);
    expect(report.supersededProposals).toHaveLength(1);
    expect(report.supersededProposals[0].epoch).toBe(1);
    expect(report.supersededProposals[0].debitSellerId).toBe("SELLER-A");
    expect(report.verdict).toBe("CORRECTED_READY_FOR_APPROVAL");
    expect(report.acceptedProposal?.epoch).toBe(2);
    expect(report.acceptedProposal?.debitSellerId).toBe("SELLER-B");
    expect(report.timeline.some((e) => e.type === "readiness.invalidated")).toBe(true);
  });

  it("Regression 1B: post-acceptance matching chargeback invalidates epoch-1 readiness, freezes checkout, and holds non-zero reserve", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.35,
      onProposalAccepted: ({ injectChargeback }) => {
        injectChargeback(buildInjectedChargeback(scenario));
      },
    });

    expect(report.finalEpoch).toBe(2);
    expect(report.supersededProposals).toHaveLength(1);
    expect(report.verdict).toBe("FROZEN_DISPUTE_COLLISION");
    expect(report.acceptedProposal).toBeNull();
    expect(report.ledger.heldReserveKsh).toBe(10_000);
    expect(report.timeline.some((e) => e.type === "readiness.invalidated")).toBe(true);
  });

  it("Regression 1C: post-acceptance update when revalidation cannot finish returns PENDING_REVALIDATION (never stale ready)", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.35,
      allowPostAcceptanceRevalidation: false,
      onProposalAccepted: ({ injectWarehouseCorrection }) => {
        injectWarehouseCorrection(buildInjectedWarehouseCorrection(scenario, "SELLER-B"));
      },
    });

    expect(report.finalEpoch).toBe(2);
    expect(report.supersededProposals).toHaveLength(1);
    expect(report.verdict).toBe("PENDING_REVALIDATION");
    expect(report.acceptedProposal).toBeNull();
  });

  // --- Audit Finding: Money Reconciliation Before Clearance ---

  it("Audit Fix 1: KSh 15,000 draft refund against KSh 10,000 posted refund fails closed with HOLD_RECONCILIATION_MISMATCH", async () => {
    const base = getScenarioById("case-1-clean-allocation");
    const mismatched: ScenarioFixture = {
      ...base,
      draft: {
        ...base.draft,
        refundAmountKsh: 15_000,
        totalBatchSettlementKsh: 85_000,
        sellerLines: [
          {
            sellerId: "SELLER-A",
            grossSalesKsh: 60_000,
            refundDeductionKsh: 15_000,
            netPayoutKsh: 45_000,
          },
          {
            sellerId: "SELLER-B",
            grossSalesKsh: 40_000,
            refundDeductionKsh: 0,
            netPayoutKsh: 40_000,
          },
        ],
      },
    };

    const report = await runRefundGuardCase(mismatched, {
      modeOverride: "mock",
      latencyScale: 0.35,
    });

    expect(report.verdict).toBe("HOLD_RECONCILIATION_MISMATCH");
    expect(report.acceptedProposal).toBeNull();
    expect(report.ledger.reconciliationMatched).toBe(false);
    expect(report.ledger.reconciliationError).toContain("KSh 15,000");
    expect(report.interceptions.some((i) => i.reason === "RECONCILIATION_MISMATCH")).toBe(true);
  });

  // --- Audit Finding: Dispute Identity, CLOSED_LOST, CLOSED_WON Replacement, & Reserve Attribution ---

  it("Regression 2A: unrelated dispute does NOT freeze a clean checkout", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.4,
      overrideInjection: {
        delayMs: 80,
        kind: "CHARGEBACK_WEBHOOK",
        chargeback: createUnrelatedDisputeFixture(),
      },
    });

    expect(report.verdict).toBe("READY_FOR_HUMAN_APPROVAL");
    expect(report.finalEpoch).toBe(1);
    expect(report.acceptedProposal?.debitSellerId).toBe("SELLER-A");
    expect(report.disputeEvaluation?.matchState).toBe("UNRELATED");
  });

  it("Regression 2B: ambiguous dispute match asks for human verification", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.4,
      overrideInjection: {
        delayMs: 90,
        kind: "CHARGEBACK_WEBHOOK",
        chargeback: createAmbiguousDisputeFixture(),
      },
    });

    expect(report.verdict).toBe("VERIFY_DISPUTE_MATCH");
    expect(report.acceptedProposal).toBeNull();
    expect(report.disputeEvaluation?.matchState).toBe("AMBIGUOUS_MATCH");
  });

  it("Audit Fix 3A: conflicting explicit paymentSettlementId, short suffix '2', and suffix-only disputes never verify as active match", () => {
    const scenario = getScenarioById("case-1-clean-allocation");

    const conflictingSettlement: ChargebackWebhookRecord = {
      disputeId: "DSP-CONF-1",
      status: "OPEN",
      receivedAt: "2026-11-26T15:00:00+03:00",
      pspReferenceSuffix: "402",
      paymentSettlementId: "STL-PAY-OTHER-999",
      cardLast4: "4421",
      amountKsh: 10_000,
      reasonCode: "VISA_13.3_NOT_AS_DESCRIBED_OR_DEFECTIVE",
      narrative: "Same suffix and card, but explicit different paymentSettlementId.",
    };
    expect(evaluateDisputeLink(scenario, conflictingSettlement).matchState).toBe("AMBIGUOUS_MATCH");

    const oneCharSuffix: ChargebackWebhookRecord = {
      ...conflictingSettlement,
      disputeId: "DSP-SHORT-2",
      paymentSettlementId: undefined,
      pspReferenceSuffix: "2",
    };
    expect(evaluateDisputeLink(scenario, oneCharSuffix).matchState).toBe("AMBIGUOUS_MATCH");

    const suffixOnly: ChargebackWebhookRecord = {
      ...conflictingSettlement,
      disputeId: "DSP-SUFFIX-ONLY",
      paymentSettlementId: undefined,
      pspReferenceSuffix: "402",
    };
    expect(evaluateDisputeLink(scenario, suffixOnly).matchState).toBe("AMBIGUOUS_MATCH");
  });

  it("Audit Fix 3B: matching CLOSED_LOST dispute blocks additional refund (never READY_FOR_HUMAN_APPROVAL)", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const closedLost: ChargebackWebhookRecord = {
      disputeId: "DSP-LOST-402",
      status: "CLOSED_LOST",
      receivedAt: "2026-11-26T15:00:00+03:00",
      pspReferenceSuffix: "402",
      paymentSettlementId: "STL-PAY-402",
      cardLast4: "4421",
      amountKsh: 10_000,
      reasonCode: "VISA_13.3_NOT_AS_DESCRIBED_OR_DEFECTIVE",
      narrative: "Prior dispute already lost to cardholder.",
    };

    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.35,
      overrideInjection: {
        delayMs: 60,
        kind: "CHARGEBACK_WEBHOOK",
        chargeback: closedLost,
      },
    });

    expect(report.verdict).toBe("FROZEN_DISPUTE_COLLISION");
    expect(report.acceptedProposal).toBeNull();
    expect(report.disputeEvaluation?.matchState).toBe("VERIFIED_LOST_DISPUTE");
    expect(report.interceptions.some((i) => i.reason === "PRIOR_DISPUTE_LOST_BLOCKED")).toBe(true);
    expect(report.ledger.heldReserveKsh).toBeGreaterThan(0);
  });

  it("Audit Fix 3C: CLOSED_WON update replaces original OPEN dispute record by disputeId", () => {
    const scenario = getScenarioById("case-5-chargeback-collision");
    const state = new RefundGuardState(scenario, "mock", "refund-guard-deterministic-v1");
    const openDispute = scenario.midFlightInjection!.chargeback!;

    state.addChargebackWebhook(openDispute);
    expect(state.getLatestRelevantChargeback()?.evaluation.matchState).toBe("VERIFIED_ACTIVE_MATCH");

    const closedWon: ChargebackWebhookRecord = {
      ...openDispute,
      status: "CLOSED_WON",
      receivedAt: "2026-11-26T16:00:00+03:00",
    };
    const res = state.addChargebackWebhook(closedWon);
    expect(res.relevant).toBe(true);
    expect(state.getLatestRelevantChargeback()).toBeNull();
  });

  it("Audit Fix 3D: frozen dispute without verified returned seller holds both checkout lines (no draft fallback, non-zero reserve)", () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const ledger = computeGroundedLedger(
      scenario,
      "FROZEN_DISPUTE_COLLISION",
      null,
      null,
      null,
    );
    const sellerA = ledger.lines.find((l) => l.sellerId === "SELLER-A")!;
    const sellerB = ledger.lines.find((l) => l.sellerId === "SELLER-B")!;
    expect(sellerA.supportedNetPayoutKsh).toBe(50_000);
    expect(sellerB.supportedNetPayoutKsh).toBe(30_000);
    expect(ledger.totalWithheldFromGrossKsh).toBe(20_000);
    expect(ledger.heldReserveKsh).toBe(10_000);
    expect(ledger.holdPolicyExplanation).toContain("without guessing from the draft");
  });

  // --- Audit Finding: Direct Gate Strictness & Repeat Proposal Guard ---

  it("Audit Fix 4A: RefundInterceptionGate blocks duplicate proposals in the same epoch", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const state = new RefundGuardState(scenario, "mock", "refund-guard-deterministic-v1");
    state.acceptedProposal = {
      epoch: 1,
      checkoutId: scenario.checkoutId,
      debitSellerId: "SELLER-A",
      refundAmountKsh: 10_000,
      rationale: "already accepted",
      citedSourceIds: ["WH-101"],
    };

    const gate = new RefundInterceptionGate(state, 50);
    const next = await gate.handle(
      makeDirectProposalTransition({
        checkoutId: scenario.checkoutId,
        debitSellerId: "SELLER-B",
        refundAmountKsh: 10_000,
        epoch: 1,
        rationale: "duplicate second call",
      }),
    );

    expect(next.nextStateId).toBe("model_message");
    expect(state.interceptions.some((i) => i.reason === "DUPLICATE_PROPOSAL_BLOCKED")).toBe(true);
    expect(state.acceptedProposal?.debitSellerId).toBe("SELLER-A");
  });

  it("Audit Fix 4B: RefundInterceptionGate rejects malformed Sentinel findings and invalid Desk proposals without draft fallback", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const baseFinding: SentinelFinding = {
      epoch: 1,
      checkoutId: scenario.checkoutId,
      status: "VERIFIED_RETURN",
      verifiedSellerId: "SELLER-A",
      verifiedLineId: "LINE-402-A",
      disputeId: null,
      evidenceNoteId: "WH-101",
      confidence: "HIGH",
      summary: "Verified",
      citedSourceIds: ["WH-101", "LINE-402-A"],
      recordedAtMs: 10,
    };

    const badFindings: SentinelFinding[] = [
      { ...baseFinding, checkoutId: "CHK-WRONG" },
      { ...baseFinding, confidence: "LOW" },
      { ...baseFinding, verifiedLineId: "LINE-402-B" }, // belongs to SELLER-B, not SELLER-A
      { ...baseFinding, evidenceNoteId: "WH-INVENTED" },
    ];

    for (const bad of badFindings) {
      const state = new RefundGuardState(scenario, "mock", "refund-guard-deterministic-v1");
      state.publishSentinelFinding(bad);
      const gate = new RefundInterceptionGate(state, 50);
      const next = await gate.handle(
        makeDirectProposalTransition({
          checkoutId: scenario.checkoutId,
          debitSellerId: "SELLER-A",
          refundAmountKsh: 10_000,
          epoch: 1,
          rationale: "test",
        }),
      );
      expect(next.nextStateId).toBe("model_message");
      expect(state.verdict).toBe("HOLD_MISSING_EVIDENCE");
    }

    // Invalid Desk proposal payloads against a valid Sentinel finding
    const badProposals = [
      { checkoutId: "CHK-WRONG", debitSellerId: "SELLER-A", refundAmountKsh: 10_000, epoch: 1 },
      { checkoutId: scenario.checkoutId, debitSellerId: "SELLER-Z", refundAmountKsh: 10_000, epoch: 1 },
      { checkoutId: scenario.checkoutId, debitSellerId: "SELLER-A", refundAmountKsh: 99_999, epoch: 1 },
      { checkoutId: scenario.checkoutId, debitSellerId: "SELLER-A", refundAmountKsh: 10_000, epoch: 99 },
    ];

    for (const badArgs of badProposals) {
      const state = new RefundGuardState(scenario, "mock", "refund-guard-deterministic-v1");
      state.publishSentinelFinding(baseFinding);
      const gate = new RefundInterceptionGate(state, 50);
      const next = await gate.handle(makeDirectProposalTransition(badArgs));
      expect(next.nextStateId).toBe("model_message");
      expect(state.interceptions.some((i) => i.reason === "INVALID_PROPOSAL_OR_FINDING")).toBe(true);
    }

    // Timeout when Sentinel never publishes current epoch (must NOT spin infinitely!)
    const staleState = new RefundGuardState(scenario, "mock", "refund-guard-deterministic-v1");
    staleState.publishSentinelFinding(baseFinding);
    staleState.epoch = 2; // epoch 2 has no finding
    const fastGate = new RefundInterceptionGate(staleState, 30);
    const nextTimeout = await fastGate.handle(
      makeDirectProposalTransition({
        checkoutId: scenario.checkoutId,
        debitSellerId: "SELLER-A",
        refundAmountKsh: 10_000,
        epoch: 2,
        rationale: "timeout check",
      }),
    );
    expect(nextTimeout.nextStateId).toBe("model_message");
    expect(staleState.verdict).toBe("HOLD_MISSING_EVIDENCE");
  });

  // --- Audit Finding: Rule-Based Mock Parser Edge Cases ---

  it("Audit Fix 5: rule-based mock parser handles negation, tentative notes, both-items, nothing-missing, and customer-kept phrasing", async () => {
    const base = getScenarioById("case-1-clean-allocation");

    const negated = await runRefundGuardCase(base, {
      modeOverride: "mock",
      latencyScale: 0.25,
      customWarehouseNoteText: "We did not receive the Navy Quilted Winter Jacket.",
    });
    expect(negated.verdict).toBe("HOLD_MISSING_EVIDENCE");

    const tentative = await runRefundGuardCase(base, {
      modeOverride: "mock",
      latencyScale: 0.25,
      customWarehouseNoteText:
        "Preliminary dock scan: tentative Tan Chelsea Boots box received. Pending bench open.",
    });
    expect(tentative.verdict).toBe("HOLD_MISSING_EVIDENCE");

    const bothItems = await runRefundGuardCase(base, {
      modeOverride: "mock",
      latencyScale: 0.25,
      customWarehouseNoteText: "Both items received in parcel for CHK-402.",
    });
    expect(bothItems.verdict).toBe("HOLD_MISSING_EVIDENCE");

    const nothingMissing = await runRefundGuardCase(base, {
      modeOverride: "mock",
      latencyScale: 0.25,
      customWarehouseNoteText: "Received jacket for CHK-402. Nothing missing.",
    });
    expect(nothingMissing.verdict).toBe("READY_FOR_HUMAN_APPROVAL");
    expect(nothingMissing.acceptedProposal?.debitSellerId).toBe("SELLER-A");

    const keptOther = await runRefundGuardCase(base, {
      modeOverride: "mock",
      latencyScale: 0.25,
      customWarehouseNoteText: "Boots came back for CHK-402; customer kept the jacket.",
    });
    expect(keptOther.verdict).toBe("CORRECTED_READY_FOR_APPROVAL");
    expect(keptOther.acceptedProposal?.debitSellerId).toBe("SELLER-B");
  });

  // --- Baseline, Batch Desk (All Pending), Live Interrupt, & HTTP 409 Server Gate ---

  it("Regression 4: Single-Agent t=0 Snapshot passes static Case 2 yet misses mid-flight Case 4", async () => {
    const case2 = getScenarioById("case-2-wrong-seller-zerosum");
    const case4 = getScenarioById("case-4-late-correction-midflight");

    const [td2, snap2, snap4, guard4] = await Promise.all([
      runTicketAndDraftBaseline(case2, { modeOverride: "mock", latencyScale: 0.4 }),
      runSingleAgentSnapshotBaseline(case2, { modeOverride: "mock", latencyScale: 0.4 }),
      runSingleAgentSnapshotBaseline(case4, { modeOverride: "mock", latencyScale: 0.5 }),
      runRefundGuardCase(case4, { modeOverride: "mock", latencyScale: 0.5 }),
    ]);

    expect(td2.acceptedProposal?.debitSellerId).toBe("SELLER-B");
    expect(snap2.acceptedProposal?.debitSellerId).toBe("SELLER-A");
    expect(snap4.acceptedProposal?.debitSellerId).toBe("SELLER-B");
    expect(guard4.acceptedProposal?.debitSellerId).toBe("SELLER-A");
    expect(guard4.finalEpoch).toBe(2);
  });

  it("Batch Desk: runs 4 concurrent checkout reviews, starts every decision as PENDING, and marks held/frozen rows non-approvable", async () => {
    const batch = await runBlackFridayBatch({ modeOverride: "mock", latencyScale: 0.4 });

    expect(batch.checkoutCount).toBe(4);
    expect(batch.concurrentAgentLoops).toBe(8);
    expect(batch.allOverlapsVerified).toBe(true);
    expect(batch.items.every((i) => i.operatorDecision === "PENDING")).toBe(true);

    const byCheckout = new Map(batch.items.map((i) => [i.checkoutId, i]));
    expect(byCheckout.get("CHK-518")?.approvable).toBe(true);
    expect(byCheckout.get("CHK-402")?.approvable).toBe(true);
    expect(byCheckout.get("CHK-629")?.approvable).toBe(false);
    expect(byCheckout.get("CHK-741")?.approvable).toBe(false);
    expect(byCheckout.get("CHK-741")?.report.ledger.blockedUnsafeRefundKsh).toBe(12_000);
  });

  it("Live interrupt hook: external mid-run injection via onSessionReady interrupts RefundDeskAgent live", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.8,
      onSessionReady: (injector) => {
        setTimeout(() => {
          injector.injectWarehouseCorrection(
            buildInjectedWarehouseCorrection(scenario, "SELLER-B"),
          );
        }, 70);
      },
    });

    expect(report.finalEpoch).toBe(2);
    expect(report.verdict).toBe("CORRECTED_READY_FOR_APPROVAL");
    expect(report.acceptedProposal?.debitSellerId).toBe("SELLER-B");
    expect(report.interceptions.some((i) => i.reason === "SUPERSEDED_EVIDENCE")).toBe(true);
  });

  it("Server Approval Gate: returns HTTP 409 Conflict on stale post-run epoch and on held verdicts, and HTTP 200 on current eligible verdict", async () => {
    const server = createRefundGuardServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const runSseSession = async (scenarioId: string): Promise<{ sessionId: string; finalEpoch: number }> => {
      const res = await fetch(`${baseUrl}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId, modeOverride: "mock" }),
      });
      const text = await res.text();
      let sessionId = "";
      let finalEpoch = 1;
      for (const chunk of text.split("\n\n")) {
        if (chunk.includes("event: report")) {
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (dataLine) {
            const parsed = JSON.parse(dataLine.slice(5).trim());
            sessionId = parsed.sessionId;
            finalEpoch = parsed.report.finalEpoch;
          }
        }
      }
      return { sessionId, finalEpoch };
    };

    try {
      // 1. Clean run -> post-run matching dispute -> approve with stale epoch 1 => 409 Conflict
      const cleanSession = await runSseSession("case-1-clean-allocation");
      const injRes = await fetch(`${baseUrl}/api/sessions/${cleanSession.sessionId}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "CHARGEBACK_MATCHING" }),
      });
      expect(injRes.status).toBe(200);
      const injJson = (await injRes.json()) as { epoch: number; approvable: boolean };
      expect(injJson.epoch).toBe(2);
      expect(injJson.approvable).toBe(false);

      const staleApproveRes = await fetch(
        `${baseUrl}/api/sessions/${cleanSession.sessionId}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ epoch: cleanSession.finalEpoch, decision: "APPROVED_FOR_RELEASE" }),
        },
      );
      expect(staleApproveRes.status).toBe(409);
      const staleJson = (await staleApproveRes.json()) as { code: string };
      expect(staleJson.code).toBe("APPROVAL_EXPIRED_STALE_EPOCH");

      // 2. Held run (missing evidence) -> approve => 409 Conflict
      const heldSession = await runSseSession("case-3-missing-evidence");
      const heldApproveRes = await fetch(
        `${baseUrl}/api/sessions/${heldSession.sessionId}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ epoch: heldSession.finalEpoch, decision: "APPROVED_FOR_RELEASE" }),
        },
      );
      expect(heldApproveRes.status).toBe(409);
      const heldJson = (await heldApproveRes.json()) as { code: string };
      expect(heldJson.code).toBe("VERDICT_NOT_APPROVABLE");

      // 3. Clean run with current epoch => 200 OK
      const validSession = await runSseSession("case-1-clean-allocation");
      const okApproveRes = await fetch(
        `${baseUrl}/api/sessions/${validSession.sessionId}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ epoch: validSession.finalEpoch, decision: "APPROVED_FOR_RELEASE" }),
        },
      );
      expect(okApproveRes.status).toBe(200);
      const okJson = (await okApproveRes.json()) as { decision: string };
      expect(okJson.decision).toBe("APPROVED_FOR_RELEASE");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // --- Round 2 Audit Regression Suite ---

  it("Round 2 Fix 1: mismatched CLOSED_WON cannot clear OPEN dispute, CLOSED_LOST is terminal, and delayed OPEN replay after CLOSED_WON cannot re-freeze", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const openDispute = buildInjectedChargeback(scenario);
    const mismatchedClose: ChargebackWebhookRecord = {
      disputeId: openDispute.disputeId,
      status: "CLOSED_WON",
      receivedAt: new Date(Date.now() + 5_000).toISOString(),
      pspReferenceSuffix: "999",
      paymentSettlementId: "STL-PAY-999",
      cardLast4: "0000",
      amountKsh: 1,
      reasonCode: "VISA_13.3_NOT_AS_DESCRIBED_OR_DEFECTIVE",
      narrative: "Mismatched closure payload.",
    };

    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.35,
      onProposalAccepted: ({ injectChargeback }) => {
        injectChargeback(openDispute);
        const rej = injectChargeback(mismatchedClose);
        expect(rej.relevant).toBe(false);
      },
    });
    expect(report.verdict).toBe("FROZEN_DISPUTE_COLLISION");
    expect(report.acceptedProposal).toBeNull();

    // Terminal CLOSED_LOST cannot be overwritten by older CLOSED_WON;
    // OPEN -> CLOSED_WON -> delayed OPEN replay stays cleared.
    const state1 = new RefundGuardState(scenario, "mock", "refund-guard-deterministic-v1");
    const lost: ChargebackWebhookRecord = {
      ...openDispute,
      disputeId: "DSP-TERM-1",
      status: "CLOSED_LOST",
      receivedAt: "2026-11-26T16:00:00+03:00",
    };
    const olderWon: ChargebackWebhookRecord = {
      ...lost,
      status: "CLOSED_WON",
      receivedAt: "2026-11-26T15:00:00+03:00",
    };
    state1.addChargebackWebhook(lost);
    expect(state1.addChargebackWebhook(olderWon).relevant).toBe(false);
    expect(state1.getLatestRelevantChargeback()?.evaluation.matchState).toBe("VERIFIED_LOST_DISPUTE");

    const state2 = new RefundGuardState(scenario, "mock", "refund-guard-deterministic-v1");
    const origOpen: ChargebackWebhookRecord = {
      ...openDispute,
      disputeId: "DSP-REPLAY-1",
      status: "OPEN",
      receivedAt: "2026-11-26T14:30:00+03:00",
    };
    const validWon: ChargebackWebhookRecord = {
      ...origOpen,
      status: "CLOSED_WON",
      receivedAt: "2026-11-26T15:30:00+03:00",
    };
    state2.addChargebackWebhook(origOpen);
    expect(state2.addChargebackWebhook(validWon).relevant).toBe(true);
    const epochAfterClose = state2.epoch;
    expect(state2.addChargebackWebhook(origOpen).relevant).toBe(false);
    expect(state2.epoch).toBe(epochAfterClose);
    expect(state2.getLatestRelevantChargeback()).toBeNull();
  });

  it("Round 2 Fix 2: warehouse replay safety ignores redelivered superseded note WH-404-V1 after WH-404-V2", () => {
    const scenario = getScenarioById("case-4-late-correction-midflight");
    const state = new RefundGuardState(scenario, "mock", "refund-guard-deterministic-v1");
    const v2 = scenario.midFlightInjection!.warehouseNote!;
    const v1 = scenario.initialWarehouseNote;

    const r1 = state.addWarehouseCorrection(v2);
    expect(r1.applied).toBe(true);
    expect(state.epoch).toBe(2);
    expect(state.getLatestWarehouseNote().noteId).toBe("WH-404-V2");

    // Redelivering WH-404-V1 must NOT restore V1 or advance epoch to 3
    const r2 = state.addWarehouseCorrection(v1);
    expect(r2.applied).toBe(false);
    expect(state.epoch).toBe(2);
    expect(state.getLatestWarehouseNote().noteId).toBe("WH-404-V2");
  });

  it("Round 2 Fix 3: line-level refundable cap, duplicate settlement dedup, unposted draft deductions, ticket mismatch, pending refund, and partial/checkout-wide dispute reserves", async () => {
    const case1 = getScenarioById("case-1-clean-allocation");

    // A) Posted + ticket + draft refund KSh 15,000 exceeds KSh 10,000 verified line
    const overLineCap: ScenarioFixture = {
      ...case1,
      settlements: case1.settlements.map((s) =>
        s.kind === "REFUND" ? { ...s, amountKsh: 15_000 } : s,
      ),
      ticket: { ...case1.ticket, requestedRefundKsh: 15_000 },
      draft: {
        ...case1.draft,
        refundAmountKsh: 15_000,
        totalBatchSettlementKsh: 85_000,
        sellerLines: [
          { sellerId: "SELLER-A", grossSalesKsh: 60_000, refundDeductionKsh: 15_000, netPayoutKsh: 45_000 },
          { sellerId: "SELLER-B", grossSalesKsh: 40_000, refundDeductionKsh: 0, netPayoutKsh: 40_000 },
        ],
      },
    };
    const rOver = await runRefundGuardCase(overLineCap, { modeOverride: "mock", latencyScale: 0.25 });
    expect(rOver.verdict).toBe("HOLD_RECONCILIATION_MISMATCH");

    // B) Duplicate STL-REF-402 record fails closed
    const dupSettlement: ScenarioFixture = {
      ...case1,
      settlements: [...case1.settlements, case1.settlements[1]],
    };
    const rDup = await runRefundGuardCase(dupSettlement, { modeOverride: "mock", latencyScale: 0.25 });
    expect(rDup.verdict).toBe("HOLD_RECONCILIATION_MISMATCH");

    // C) No posted refund + invalid draft deductions (A:55k, B:40k) fails closed
    const case5 = getScenarioById("case-5-chargeback-collision");
    const bogusUnposted: ScenarioFixture = {
      ...case5,
      midFlightInjection: undefined,
      draft: {
        ...case5.draft,
        sellerLines: [
          { sellerId: "SELLER-A", grossSalesKsh: 60_000, refundDeductionKsh: 55_000, netPayoutKsh: 5_000 },
          { sellerId: "SELLER-B", grossSalesKsh: 40_000, refundDeductionKsh: 40_000, netPayoutKsh: 0 },
        ],
      },
    };
    const rBogus = await runRefundGuardCase(bogusUnposted, { modeOverride: "mock", latencyScale: 0.25 });
    expect(rBogus.verdict).toBe("HOLD_RECONCILIATION_MISMATCH");

    // D) Ticket asks 15,000 while posted & draft refund are 10,000 fails closed
    const ticketDiff: ScenarioFixture = {
      ...case1,
      ticket: { ...case1.ticket, requestedRefundKsh: 15_000 },
    };
    const rTicket = await runRefundGuardCase(ticketDiff, { modeOverride: "mock", latencyScale: 0.25 });
    expect(rTicket.verdict).toBe("HOLD_RECONCILIATION_MISMATCH");

    // E) Case 5 with dispute disabled explicitly accounts for pendingRefundKsh = 10,000
    const rPending = await runRefundGuardCase(case5, {
      modeOverride: "mock",
      latencyScale: 0.25,
      overrideInjection: null,
    });
    expect(rPending.verdict).toBe("READY_FOR_HUMAN_APPROVAL");
    expect(rPending.ledger.pendingRefundKsh).toBe(10_000);
    expect(rPending.ledger.supportedTotalKsh).toBe(90_000);
    expect(rPending.ledger.holdPolicyExplanation).toContain("pending refund");

    // F) Case 5 with KSh 5,000 partial dispute holds KSh 5,000; KSh 20,000 checkout-wide dispute holds KSh 20,000
    const baseDispute = case5.midFlightInjection!.chargeback!;
    const rPartialDispute = await runRefundGuardCase(case5, {
      modeOverride: "mock",
      latencyScale: 0.25,
      overrideInjection: {
        delayMs: 50,
        kind: "CHARGEBACK_WEBHOOK",
        chargeback: { ...baseDispute, amountKsh: 5_000 },
      },
    });
    expect(rPartialDispute.verdict).toBe("FROZEN_DISPUTE_COLLISION");
    expect(rPartialDispute.ledger.heldReserveKsh).toBe(5_000);

    const rWideDispute = await runRefundGuardCase(case5, {
      modeOverride: "mock",
      latencyScale: 0.25,
      overrideInjection: {
        delayMs: 50,
        kind: "CHARGEBACK_WEBHOOK",
        chargeback: { ...baseDispute, amountKsh: 20_000 },
      },
    });
    expect(rWideDispute.verdict).toBe("FROZEN_DISPUTE_COLLISION");
    expect(rWideDispute.ledger.heldReserveKsh).toBe(20_000);
  });

  it("Round 2 Fix 4: exterior barcode-only and non-return phrasings fail closed, and blank checkoutId / invented citations are rejected by gate", async () => {
    const case1 = getScenarioById("case-1-clean-allocation");
    const nonReturnNotes = [
      "Exterior carton barcode only: JKT-NVY-L (Seller A). Contents never checked.",
      "The jacket wasn't in the box.",
      "We could not locate the Navy Quilted Winter Jacket.",
      "Jacket JKT-NVY-L is still in transit.",
      "Customer claims the jacket was returned; hub has not seen it.",
      "Jacket JKT-NVY-L expected tomorrow.",
      "Parcel contained a jacket, but it is not the ordered item (wrong brand, red, size S).",
    ];

    for (const note of nonReturnNotes) {
      const r = await runRefundGuardCase(case1, {
        modeOverride: "mock",
        latencyScale: 0.2,
        customWarehouseNoteText: note,
      });
      expect(r.verdict, `Expected HOLD_MISSING_EVIDENCE for: ${note}`).toBe(
        "HOLD_MISSING_EVIDENCE",
      );
    }

    // Blank checkoutId and invented citedSourceIds must fail gate validation
    const badGateFindings: SentinelFinding[] = [
      {
        epoch: 1,
        checkoutId: "",
        status: "VERIFIED_RETURN",
        verifiedSellerId: "SELLER-A",
        verifiedLineId: "LINE-402-A",
        disputeId: null,
        evidenceNoteId: "WH-101",
        confidence: "HIGH",
        summary: "blank checkout",
        citedSourceIds: ["WH-101", "LINE-402-A"],
        recordedAtMs: 5,
      },
      {
        epoch: 1,
        checkoutId: case1.checkoutId,
        status: "VERIFIED_RETURN",
        verifiedSellerId: "SELLER-A",
        verifiedLineId: "LINE-402-A",
        disputeId: null,
        evidenceNoteId: "WH-101",
        confidence: "HIGH",
        summary: "invented citation",
        citedSourceIds: ["WH-101", "LINE-402-A", "INVENTED-1"],
        recordedAtMs: 5,
      },
    ];

    for (const bad of badGateFindings) {
      const state = new RefundGuardState(case1, "mock", "refund-guard-deterministic-v1");
      state.publishSentinelFinding(bad);
      const gate = new RefundInterceptionGate(state, 50);
      const next = await gate.handle(
        makeDirectProposalTransition({
          checkoutId: case1.checkoutId,
          debitSellerId: "SELLER-A",
          refundAmountKsh: 10_000,
          epoch: 1,
          rationale: "test",
        }),
      );
      expect(next.nextStateId).toBe("model_message");
      expect(state.verdict).toBe("HOLD_MISSING_EVIDENCE");
    }
  });

  // --- Final Pre-Submission Blocker Regressions (5/5) ---

  it("Blocker 1: sealed carton with external sticker and future-return promise both return HOLD_MISSING_EVIDENCE", async () => {
    const case1 = getScenarioById("case-1-clean-allocation");
    const sealed = await runRefundGuardCase(case1, {
      modeOverride: "mock",
      latencyScale: 0.2,
      customWarehouseNoteText:
        "Carton remains sealed. External sticker reads JKT-NVY-L (Seller A).",
    });
    expect(sealed.verdict).toBe("HOLD_MISSING_EVIDENCE");
    expect(sealed.acceptedProposal).toBeNull();

    const futurePromise = await runRefundGuardCase(case1, {
      modeOverride: "mock",
      latencyScale: 0.2,
      customWarehouseNoteText: "Customer will send back JKT-NVY-L (Seller A) next week.",
    });
    expect(futurePromise.verdict).toBe("HOLD_MISSING_EVIDENCE");
    expect(futurePromise.acceptedProposal).toBeNull();
  });

  it("Blocker 2: post-run QC correction followed by matching dispute does NOT reuse obsolete WH-505 finding to attribute reserve to Seller A", async () => {
    const case5 = getScenarioById("case-5-chargeback-collision");
    let sessionInjector: PostAcceptanceInjector | undefined;

    const initialReport = await runRefundGuardCase(case5, {
      modeOverride: "mock",
      latencyScale: 0.25,
      overrideInjection: null,
      onSessionReady: (inj) => {
        sessionInjector = inj;
      },
    });
    expect(initialReport.verdict).toBe("READY_FOR_HUMAN_APPROVAL");
    expect(sessionInjector).toBeDefined();

    // Post-run QC correction to Seller B (epoch 1 -> 2), then matching dispute (epoch 2 -> 3)
    sessionInjector!.injectWarehouseCorrection(
      buildInjectedWarehouseCorrection(case5, "SELLER-B"),
    );
    sessionInjector!.injectChargeback(buildInjectedChargeback(case5));

    const snap = sessionInjector!.getCurrentSnapshot();
    expect(snap.epoch).toBe(3);
    expect(snap.verdict).toBe("FROZEN_DISPUTE_COLLISION");
    expect(snap.approvable).toBe(false);
    // Must hold BOTH sellers (KSh 20,000) rather than attributing Seller A from obsolete WH-505
    const sellerA = snap.report.ledger.lines.find((l) => l.sellerId === "SELLER-A")!;
    const sellerB = snap.report.ledger.lines.find((l) => l.sellerId === "SELLER-B")!;
    expect(sellerA.supportedNetPayoutKsh).toBe(50_000);
    expect(sellerB.supportedNetPayoutKsh).toBe(30_000);
    expect(snap.report.ledger.heldReserveKsh).toBe(20_000);
  });

  it("Blocker 3: out-of-order CLOSED_WON (15:30) blocks older OPEN (14:30), and CHK-402 closure clears 402 OPEN while mismatched closure stays rejected", () => {
    const case1 = getScenarioById("case-1-clean-allocation");
    const state1 = new RefundGuardState(case1, "mock", MOCK_MODEL_NAME);

    const closedFirst: ChargebackWebhookRecord = {
      disputeId: "DSP-OOO-1",
      status: "CLOSED_WON",
      receivedAt: "2026-11-26T15:30:00+03:00",
      pspReferenceSuffix: "402",
      paymentSettlementId: "STL-PAY-402",
      cardLast4: "4421",
      amountKsh: 10_000,
      reasonCode: "VISA_13.3_NOT_AS_DESCRIBED_OR_DEFECTIVE",
      narrative: "Resolved in merchant favor at 15:30.",
    };
    const olderOpen: ChargebackWebhookRecord = {
      ...closedFirst,
      status: "OPEN",
      receivedAt: "2026-11-26T14:30:00+03:00",
      narrative: "Delayed original OPEN webhook from 14:30.",
    };

    expect(state1.addChargebackWebhook(closedFirst).relevant).toBe(false);
    expect(state1.addChargebackWebhook(olderOpen).relevant).toBe(false);
    expect(state1.getLatestRelevantChargeback()).toBeNull();

    // Equivalent checkout ref ("CHK-402" vs "402") clears original OPEN
    const state2 = new RefundGuardState(case1, "mock", MOCK_MODEL_NAME);
    const openShortRef: ChargebackWebhookRecord = {
      ...olderOpen,
      disputeId: "DSP-REF-EQ",
      pspReferenceSuffix: "402",
    };
    const closeFullRef: ChargebackWebhookRecord = {
      ...closedFirst,
      disputeId: "DSP-REF-EQ",
      pspReferenceSuffix: "CHK-402",
    };
    expect(state2.addChargebackWebhook(openShortRef).relevant).toBe(true);
    expect(state2.getLatestRelevantChargeback()?.evaluation.matchState).toBe("VERIFIED_ACTIVE_MATCH");
    expect(state2.addChargebackWebhook(closeFullRef).relevant).toBe(true);
    expect(state2.getLatestRelevantChargeback()).toBeNull();

    // Genuinely mismatched ref ("999") is still rejected
    const state3 = new RefundGuardState(case1, "mock", MOCK_MODEL_NAME);
    state3.addChargebackWebhook(openShortRef);
    const badRefClose: ChargebackWebhookRecord = {
      ...closedFirst,
      disputeId: "DSP-REF-EQ",
      pspReferenceSuffix: "999",
    };
    expect(state3.addChargebackWebhook(badRefClose).relevant).toBe(false);
    expect(state3.getLatestRelevantChargeback()?.evaluation.matchState).toBe("VERIFIED_ACTIVE_MATCH");
  });

  it("Blocker 4: observer tags the actual finishing loop by loopId when epoch-2 Sentinel finishes before delayed epoch-1 Sentinel", async () => {
    const scenario = getScenarioById("case-4-late-correction-midflight");
    const baseMock = new RefundGuardMockRunner(0.2);

    // Delay ONLY epoch-1 Sentinel inference by 420ms so epoch-2 Sentinel (started at 30ms) finishes FIRST
    const delayedRunner: InferenceRunner = {
      async run(input: InferenceInput): Promise<InferenceOutput> {
        const toolNames = new Set((input.tools ?? []).map((t) => t.name));
        const userText = input.context
          .getItems()
          .filter((item): item is UserMessageItem => item instanceof UserMessageItem)
          .map((m) => m.content.text)
          .join("\n");
        if (toolNames.has("publish_sentinel_finding") && userText.includes("CURRENT_EPOCH: 1")) {
          await new Promise((r) => setTimeout(r, 420));
        }
        return baseMock.run(input);
      },
      stream(input: InferenceInput) {
        return baseMock.stream(input);
      },
    };

    const resolved = resolveInferenceMode({ modeOverride: "mock", latencyScale: 0.2 });
    const runtime = createRefundGuardRuntime();
    const state = new RefundGuardState(scenario, "mock", MOCK_MODEL_NAME);
    runtime.initializeRuntime({
      state,
      inferenceRunnerConfig: {
        supportedModels: resolved.inferenceRunnerConfig!.supportedModels,
        runner: delayedRunner,
      },
    });

    const coordinator = createHuman({ name: "OperatorFeed", capabilities: [], handlers: [] });
    const refundDesk = createRefundDeskAgent(runtime, state);
    const sentinel = createSentinelAgent(runtime, state);
    const observer = createAuditObserver(state, refundDesk.getId(), sentinel.getId());
    runtime.join(coordinator);
    runtime.join(refundDesk);
    runtime.join(sentinel);
    runtime.join(observer);

    setTimeout(() => {
      const note = scenario.midFlightInjection!.warehouseNote!;
      const { epoch, invalidatedPriorApproval } = state.addWarehouseCorrection(note);
      runtime.sendEvent(
        SemanticEvent.create("evidence.updated", coordinator.getId(), {
          epoch,
          kind: "WAREHOUSE_CORRECTION",
          sourceId: note.noteId,
          invalidatedPriorApproval,
        }),
        coordinator.getId(),
      );
    }, 30);

    runtime.sendEvent(
      SemanticEvent.create("case.opened", coordinator.getId(), {
        scenarioId: scenario.id,
        epoch: 1,
      }),
      coordinator.getId(),
    );

    await state.waitUntilComplete(8_000);

    const sentinelCompletions = state.timeline.filter(
      (e) =>
        e.actor === "DisputeFulfillmentSentinel" &&
        (e.type === "agent.completed" || e.type === "agent.completed_stale"),
    );
    expect(sentinelCompletions).toHaveLength(2);
    // Epoch 2 finished FIRST -> must be tagged agent.completed (NOT stale!)
    expect(sentinelCompletions[0].type).toBe("agent.completed");
    expect(sentinelCompletions[0].data?.loopEpoch).toBe(2);
    // Delayed Epoch 1 finished LATER -> must be tagged agent.completed_stale!
    expect(sentinelCompletions[1].type).toBe("agent.completed_stale");
    expect(sentinelCompletions[1].data?.staleLoopEpoch).toBe(1);
    expect(sentinelCompletions[1].message).toContain("[STALE epoch 1 superseded by epoch 2]");

    // Timing windows must also reflect epoch-1 finishing AFTER epoch-2
    const win1 = state.sentinelWindows.find((w) => w.epoch === 1)!;
    const win2 = state.sentinelWindows.find((w) => w.epoch === 2)!;
    expect(win1.endedAtMs!).toBeGreaterThan(win2.endedAtMs!);
  });

  it("Blocker 5: post-run /inject response returns refreshed sourceRecords containing the newly cited dispute ID", async () => {
    const server = createRefundGuardServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const runRes = await fetch(`${baseUrl}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId: "case-1-clean-allocation", modeOverride: "mock" }),
      });
      const sse = await runRes.text();
      let sessionId = "";
      for (const chunk of sse.split("\n\n")) {
        if (chunk.includes("event: report")) {
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (line) sessionId = JSON.parse(line.slice(5).trim()).sessionId;
        }
      }

      const injRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "CHARGEBACK_MATCHING" }),
      });
      expect(injRes.status).toBe(200);
      const injJson = (await injRes.json()) as {
        disputeId: string;
        report: { ledger: { allCitations: string[] } };
        sourceRecords: { dispute: { disputeId: string } | null };
      };
      expect(injJson.report.ledger.allCitations).toContain(injJson.disputeId);
      expect(injJson.sourceRecords.dispute?.disputeId).toBe(injJson.disputeId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
