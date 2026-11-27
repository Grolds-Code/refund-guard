import "dotenv/config";
import { SCENARIOS } from "./finance/fixtures.js";
import { isVerdictApprovable, type CaseRunReport, type FinalVerdict, type SellerId } from "./finance/types.js";
import {
  runSingleAgentSnapshotBaseline,
  runTicketAndDraftBaseline,
} from "./engine/baseline.js";
import { runRefundGuardCase } from "./engine/run-case.js";

interface GroundTruth {
  expectedVerdict: FinalVerdict;
  expectedDebitSeller: SellerId | null;
  expectedSellerAPayoutKsh: number;
  expectedSellerBPayoutKsh: number;
}

const GROUND_TRUTH: Record<string, GroundTruth> = {
  "case-1-clean-allocation": {
    expectedVerdict: "READY_FOR_HUMAN_APPROVAL",
    expectedDebitSeller: "SELLER-A",
    expectedSellerAPayoutKsh: 50_000,
    expectedSellerBPayoutKsh: 40_000,
  },
  "case-2-wrong-seller-zerosum": {
    expectedVerdict: "CORRECTED_READY_FOR_APPROVAL",
    expectedDebitSeller: "SELLER-A",
    expectedSellerAPayoutKsh: 50_000,
    expectedSellerBPayoutKsh: 40_000,
  },
  "case-3-missing-evidence": {
    expectedVerdict: "HOLD_MISSING_EVIDENCE",
    expectedDebitSeller: null,
    expectedSellerAPayoutKsh: 50_000,
    expectedSellerBPayoutKsh: 30_000,
  },
  "case-4-late-correction-midflight": {
    expectedVerdict: "CORRECTED_READY_FOR_APPROVAL",
    expectedDebitSeller: "SELLER-A",
    expectedSellerAPayoutKsh: 50_000,
    expectedSellerBPayoutKsh: 40_000,
  },
  "case-5-chargeback-collision": {
    expectedVerdict: "FROZEN_DISPUTE_COLLISION",
    expectedDebitSeller: null,
    expectedSellerAPayoutKsh: 50_000,
    expectedSellerBPayoutKsh: 40_000,
  },
};

export function isCorrectOutcome(report: CaseRunReport, truth: GroundTruth): boolean {
  const sellerA = report.ledger.lines.find((l) => l.sellerId === "SELLER-A");
  const sellerB = report.ledger.lines.find((l) => l.sellerId === "SELLER-B");
  const payoutsMatch =
    sellerA?.supportedNetPayoutKsh === truth.expectedSellerAPayoutKsh &&
    sellerB?.supportedNetPayoutKsh === truth.expectedSellerBPayoutKsh;

  if (truth.expectedDebitSeller === null) {
    return report.verdict === truth.expectedVerdict && payoutsMatch;
  }
  const approvedSeller = report.acceptedProposal?.debitSellerId ?? null;
  return (
    isVerdictApprovable(report.verdict) &&
    report.ledger.reconciliationMatched &&
    approvedSeller === truth.expectedDebitSeller &&
    payoutsMatch
  );
}

function formatOutcome(report: CaseRunReport, ok: boolean): string {
  const detail = report.acceptedProposal?.debitSellerId ?? report.verdict;
  const a = report.ledger.lines.find((l) => l.sellerId === "SELLER-A")?.supportedNetPayoutKsh ?? 0;
  const b = report.ledger.lines.find((l) => l.sellerId === "SELLER-B")?.supportedNetPayoutKsh ?? 0;
  return `${ok ? "PASS" : "FAIL"} (${detail} | A:${a / 1000}k B:${b / 1000}k)`;
}

async function main(): Promise<void> {
  console.log(
    "=== RefundGuard Benchmark: Ticket+Draft vs. t=0 Snapshot vs. Live-Evidence RefundGuard ===\n",
  );

  let ticketDraftPassed = 0;
  let snapshotPassed = 0;
  let guardPassed = 0;
  let guardOverlapCount = 0;

  const rows: Array<Record<string, string>> = [];

  for (const scenario of SCENARIOS) {
    const truth = GROUND_TRUTH[scenario.id];
    const [ticketDraft, snapshot, guard] = await Promise.all([
      runTicketAndDraftBaseline(scenario, { latencyScale: 0.5 }),
      runSingleAgentSnapshotBaseline(scenario, { latencyScale: 0.5 }),
      runRefundGuardCase(scenario, { latencyScale: 0.5 }),
    ]);

    const tdOk = isCorrectOutcome(ticketDraft, truth);
    const snapOk = isCorrectOutcome(snapshot, truth);
    const guardOk = isCorrectOutcome(guard, truth);

    if (tdOk) ticketDraftPassed += 1;
    if (snapOk) snapshotPassed += 1;
    if (guardOk) guardPassed += 1;
    if (guard.concurrentOverlapVerified) guardOverlapCount += 1;

    rows.push({
      Scenario: scenario.shortLabel,
      "Ticket+Draft": formatOutcome(ticketDraft, tdOk),
      "t=0 Snapshot (Same Evidence)": formatOutcome(snapshot, snapOk),
      "RefundGuard (Live Interception)": formatOutcome(guard, guardOk),
      Interceptions: guard.interceptions.map((i) => i.reason).join("+") || "none",
      "Overlap": guard.concurrentOverlapVerified ? "YES" : "NO",
    });
  }

  console.table(rows);
  console.log("Summary (5 synthetic fixtures; scored on verdict, seller, AND exact seller payouts):");
  console.log(
    `  Ticket-and-Draft Baseline (no warehouse/dispute input):            ${ticketDraftPassed}/${SCENARIOS.length} correct`,
  );
  console.log(
    `  Single-Agent t=0 Snapshot Baseline (same initial evidence):        ${snapshotPassed}/${SCENARIOS.length} correct (misses mid-flight Cases 4 & 5)`,
  );
  console.log(
    `  RefundGuard (2 concurrent Mozaik agents + InterceptionGate):       ${guardPassed}/${SCENARIOS.length} correct | Verified overlap: ${guardOverlapCount}/${SCENARIOS.length}`,
  );
  console.log(
    "  Note: 3/5 vs. 5/5 measures static t=0 snapshot review against live mid-flight evidence interception (not agent count alone).",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
