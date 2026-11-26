import { describe, expect, it } from "vitest";
import { getScenarioById } from "../src/finance/fixtures.js";
import { runSingleAgentBaseline } from "../src/engine/baseline.js";
import { runRefundGuardCase } from "../src/engine/run-case.js";

describe("RefundGuard — Concurrent Mozaik Interception Suite", () => {
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

    const sellerA = report.ledger.lines.find((l) => l.sellerId === "SELLER-A")!;
    const sellerB = report.ledger.lines.find((l) => l.sellerId === "SELLER-B")!;
    expect(sellerA.supportedNetPayoutKsh).toBe(50_000);
    expect(sellerB.supportedNetPayoutKsh).toBe(40_000);
    expect(report.ledger.supportedTotalKsh).toBe(90_000);
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
    // Draft balanced to KSh 90,000 (60k / 30k), supported flips to 50k / 40k (still 90k)
    expect(report.ledger.totalStillMatchesExactly).toBe(true);
    expect(sellerA.draftNetPayoutKsh).toBe(60_000);
    expect(sellerB.draftNetPayoutKsh).toBe(30_000);
    expect(sellerA.supportedNetPayoutKsh).toBe(50_000);
    expect(sellerB.supportedNetPayoutKsh).toBe(40_000);
    expect(report.ledger.supportedTotalKsh).toBe(90_000);
    expect(report.ledger.misallocationCaughtKsh).toBe(10_000);
  });

  it("Case 3: fails closed and holds release when warehouse evidence is missing", async () => {
    const scenario = getScenarioById("case-3-missing-evidence");
    const report = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.4,
    });

    expect(report.verdict).toBe("HOLD_MISSING_EVIDENCE");
    expect(report.concurrentOverlapVerified).toBe(true);
    expect(report.acceptedProposal).toBeNull();
    expect(report.interceptions.some((i) => i.reason === "MISSING_EVIDENCE")).toBe(true);
    expect(report.ledger.heldAmountKsh).toBeGreaterThan(0);
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

  it("Case 5: blocks a KSh 10,000 double-payout when an async chargeback webhook collides mid-flight", async () => {
    const scenario = getScenarioById("case-5-chargeback-collision");
    const [baseline, guard] = await Promise.all([
      runSingleAgentBaseline(scenario, { modeOverride: "mock", latencyScale: 0.5 }),
      runRefundGuardCase(scenario, { modeOverride: "mock", latencyScale: 0.5 }),
    ]);

    // Single-agent baseline misses the mid-flight bank chargeback and approves!
    expect(baseline.verdict).toBe("READY_FOR_HUMAN_APPROVAL");
    expect(baseline.acceptedProposal?.debitSellerId).toBe("SELLER-A");

    // Concurrent RefundGuard intercepts and freezes the double-payout!
    expect(guard.finalEpoch).toBe(2);
    expect(guard.verdict).toBe("FROZEN_DISPUTE_COLLISION");
    expect(guard.concurrentOverlapVerified).toBe(true);
    expect(guard.acceptedProposal).toBeNull();
    expect(guard.interceptions.some((i) => i.reason === "DOUBLE_PAYOUT_BLOCKED")).toBe(true);
    expect(guard.ledger.doublePayoutPreventedKsh).toBe(10_000);
    expect(guard.ledger.allCitations).toContain("DSP-505");
  });

  it("Interactive input flip: editing the warehouse note from Jacket (Seller A) to Boots (Seller B) flips the verdict live", async () => {
    const scenario = getScenarioById("case-2-wrong-seller-zerosum");
    const flipped = await runRefundGuardCase(scenario, {
      modeOverride: "mock",
      latencyScale: 0.4,
      customWarehouseNoteText:
        "Kisumu Hub intake — Confirmed return of 1x Tan Leather Chelsea Boots (SKU BTS-TAN-42, Rift Valley Footwear). Jacket was NOT returned.",
    });

    expect(flipped.verdict).toBe("READY_FOR_HUMAN_APPROVAL");
    expect(flipped.interceptions).toHaveLength(0);
    expect(flipped.acceptedProposal?.debitSellerId).toBe("SELLER-B");
    const sellerA = flipped.ledger.lines.find((l) => l.sellerId === "SELLER-A")!;
    const sellerB = flipped.ledger.lines.find((l) => l.sellerId === "SELLER-B")!;
    expect(sellerA.supportedNetPayoutKsh).toBe(60_000);
    expect(sellerB.supportedNetPayoutKsh).toBe(30_000);
  });
});
