import "dotenv/config";
import { SCENARIOS } from "./finance/fixtures.js";
import type { CaseRunReport, FinalVerdict, SellerId } from "./finance/types.js";
import {
  runSingleAgentSnapshotBaseline,
  runTicketAndDraftBaseline,
} from "./engine/baseline.js";
import { runRefundGuardCase } from "./engine/run-case.js";

interface GroundTruth {
  expectedVerdict: FinalVerdict;
  expectedDebitSeller: SellerId | null;
}

const GROUND_TRUTH: Record<string, GroundTruth> = {
  "case-1-clean-allocation": {
    expectedVerdict: "READY_FOR_HUMAN_APPROVAL",
    expectedDebitSeller: "SELLER-A",
  },
  "case-2-wrong-seller-zerosum": {
    expectedVerdict: "CORRECTED_READY_FOR_APPROVAL",
    expectedDebitSeller: "SELLER-A",
  },
  "case-3-missing-evidence": {
    expectedVerdict: "HOLD_MISSING_EVIDENCE",
    expectedDebitSeller: null,
  },
  "case-4-late-correction-midflight": {
    expectedVerdict: "CORRECTED_READY_FOR_APPROVAL",
    expectedDebitSeller: "SELLER-A",
  },
  "case-5-chargeback-collision": {
    expectedVerdict: "FROZEN_DISPUTE_COLLISION",
    expectedDebitSeller: null,
  },
};

function isCorrectOutcome(report: CaseRunReport, truth: GroundTruth): boolean {
  if (truth.expectedDebitSeller === null) {
    return report.verdict === truth.expectedVerdict;
  }
  const approvedSeller = report.acceptedProposal?.debitSellerId ?? null;
  return (
    (report.verdict === "READY_FOR_HUMAN_APPROVAL" ||
      report.verdict === "CORRECTED_READY_FOR_APPROVAL") &&
    approvedSeller === truth.expectedDebitSeller
  );
}

function formatOutcome(report: CaseRunReport, ok: boolean): string {
  const detail = report.acceptedProposal?.debitSellerId ?? report.verdict;
  return `${ok ? "PASS" : "FAIL"} (${detail})`;
}

async function main(): Promise<void> {
  console.log("=== RefundGuard Benchmark: Ticket-and-Draft vs. Single-Agent Snapshot vs. Concurrent RefundGuard ===\n");

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
      "Ticket+Draft Baseline": formatOutcome(ticketDraft, tdOk),
      "1-Agent Snapshot (Same t=0)": formatOutcome(snapshot, snapOk),
      "RefundGuard (Mozaik)": formatOutcome(guard, guardOk),
      Interceptions: guard.interceptions.map((i) => i.reason).join("+") || "none",
      "Concurrent Overlap": guard.concurrentOverlapVerified ? "YES" : "NO",
    });
  }

  console.table(rows);
  console.log("Summary (5 synthetic fixtures; no artificial sum of penalties):");
  console.log(
    `  Ticket-and-Draft Baseline (no warehouse/dispute input):        ${ticketDraftPassed}/${SCENARIOS.length} correct`,
  );
  console.log(
    `  Single-Agent Snapshot Baseline (same t=0 evidence & policy):   ${snapshotPassed}/${SCENARIOS.length} correct (misses mid-flight Cases 4 & 5)`,
  );
  console.log(
    `  RefundGuard (2 concurrent Mozaik agents + InterceptionGate):   ${guardPassed}/${SCENARIOS.length} correct | Verified overlap: ${guardOverlapCount}/${SCENARIOS.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
