import { describe, expect, it } from "vitest";
import {
  createAmbiguousDisputeFixture,
  createUnrelatedDisputeFixture,
  getScenarioById,
} from "../src/finance/fixtures.js";
import {
  runSingleAgentSnapshotBaseline,
  runTicketAndDraftBaseline,
} from "../src/engine/baseline.js";
import {
  buildInjectedChargeback,
  buildInjectedWarehouseCorrection,
  runRefundGuardCase,
} from "../src/engine/run-case.js";

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

    // Fair Single-Agent Snapshot Baseline (same t=0 evidence & policy) still approves
    // because the dispute arrives mid-flight with no concurrent Sentinel or InterceptionHandler.
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
    // Seller A's disputed KSh 10,000 checkout line is held; Seller B's KSh 40,000 remains clear.
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

  // --- Audit Regression Suite (Finding 1: Post-acceptance invalidation) ---

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

  it("Regression 1B: post-acceptance matching chargeback invalidates epoch-1 readiness and freezes checkout", async () => {
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

  // --- Audit Regression Suite (Finding 2: Dispute payment linkage) ---

  it("Regression 2A: unrelated dispute (different checkout, card, and amount) does NOT freeze a clean checkout", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const unrelated = createUnrelatedDisputeFixture();
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.4,
      overrideInjection: {
        delayMs: 80,
        kind: "CHARGEBACK_WEBHOOK",
        chargeback: unrelated,
      },
    });

    expect(report.verdict).toBe("READY_FOR_HUMAN_APPROVAL");
    expect(report.finalEpoch).toBe(1);
    expect(report.acceptedProposal?.debitSellerId).toBe("SELLER-A");
    expect(report.interceptions).toHaveLength(0);
    expect(report.disputeEvaluation?.matchState).toBe("UNRELATED");
    expect(report.ledger.blockedUnsafeRefundKsh).toBe(0);
    expect(report.ledger.heldReserveKsh).toBe(0);
    expect(report.timeline.some((e) => e.type === "evidence.chargeback_ignored")).toBe(true);
  });

  it("Regression 2B: ambiguous dispute match (matching card & amount, mismatched checkout suffix) asks for human verification", async () => {
    const scenario = getScenarioById("case-1-clean-allocation");
    const ambiguous = createAmbiguousDisputeFixture();
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.4,
      overrideInjection: {
        delayMs: 90,
        kind: "CHARGEBACK_WEBHOOK",
        chargeback: ambiguous,
      },
    });

    expect(report.verdict).toBe("VERIFY_DISPUTE_MATCH");
    expect(report.acceptedProposal).toBeNull();
    expect(report.disputeEvaluation?.matchState).toBe("AMBIGUOUS_MATCH");
    expect(report.interceptions.some((i) => i.reason === "AMBIGUOUS_DISPUTE_MATCH")).toBe(true);
    expect(report.ledger.blockedUnsafeRefundKsh).toBe(0);
  });

  // --- Audit Regression Suite (Finding 4: Fair concurrency-isolating baseline) ---

  it("Regression 4: Single-Agent Snapshot Baseline passes static Case 2 with same t=0 evidence, isolating concurrency to mid-flight Case 4", async () => {
    const case2 = getScenarioById("case-2-wrong-seller-zerosum");
    const case4 = getScenarioById("case-4-late-correction-midflight");

    const [td2, snap2, snap4, guard4] = await Promise.all([
      runTicketAndDraftBaseline(case2, { modeOverride: "mock", latencyScale: 0.4 }),
      runSingleAgentSnapshotBaseline(case2, { modeOverride: "mock", latencyScale: 0.4 }),
      runSingleAgentSnapshotBaseline(case4, { modeOverride: "mock", latencyScale: 0.5 }),
      runRefundGuardCase(case4, { modeOverride: "mock", latencyScale: 0.5 }),
    ]);

    // Ticket-and-draft baseline misses static Case 2; Snapshot baseline catches it!
    expect(td2.acceptedProposal?.debitSellerId).toBe("SELLER-B");
    expect(snap2.acceptedProposal?.debitSellerId).toBe("SELLER-A");

    // On mid-flight Case 4, even the full-snapshot single agent commits stale Seller B,
    // while concurrent RefundGuard intercepts and corrects to Seller A at epoch 2.
    expect(snap4.acceptedProposal?.debitSellerId).toBe("SELLER-B");
    expect(guard4.acceptedProposal?.debitSellerId).toBe("SELLER-A");
    expect(guard4.finalEpoch).toBe(2);
  });

  it("Batch Desk: runs 4 distinct checkouts (8 concurrent Mozaik agent loops) and isolates exceptions", async () => {
    const { runBlackFridayBatch } = await import("../src/engine/run-batch.js");
    const batch = await runBlackFridayBatch({ modeOverride: "mock", latencyScale: 0.4 });

    expect(batch.checkoutCount).toBe(4);
    expect(batch.concurrentAgentLoops).toBe(8);
    expect(batch.allOverlapsVerified).toBe(true);
    expect(batch.autoClearedCount).toBe(1);
    expect(batch.exceptionCount).toBe(3);

    const byCheckout = new Map(batch.items.map((i) => [i.checkoutId, i]));
    expect(byCheckout.get("CHK-518")?.report.verdict).toBe("READY_FOR_HUMAN_APPROVAL");
    expect(byCheckout.get("CHK-518")?.report.acceptedProposal?.debitSellerId).toBe("SELLER-A");
    expect(byCheckout.get("CHK-402")?.report.verdict).toBe("CORRECTED_READY_FOR_APPROVAL");
    expect(byCheckout.get("CHK-402")?.report.acceptedProposal?.debitSellerId).toBe("SELLER-A");
    expect(byCheckout.get("CHK-629")?.report.verdict).toBe("HOLD_MISSING_EVIDENCE");
    expect(byCheckout.get("CHK-741")?.report.verdict).toBe("FROZEN_DISPUTE_COLLISION");
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
});
