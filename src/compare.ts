import "dotenv/config";
import { SCENARIOS } from "./finance/fixtures.js";
import { formatKsh } from "./finance/ledger.js";
import type { CaseRunReport, FinalVerdict, SellerId } from "./finance/types.js";
import { runSingleAgentBaseline } from "./engine/baseline.js";
import { runRefundGuardCase } from "./engine/run-case.js";

interface GroundTruth {
  expectedVerdict: FinalVerdict;
  expectedDebitSeller: SellerId | null;
  exposureIfWrongKsh: number;
}

const GROUND_TRUTH: Record<string, GroundTruth> = {
  "case-1-clean-allocation": {
    expectedVerdict: "READY_FOR_HUMAN_APPROVAL",
    expectedDebitSeller: "SELLER-A",
    exposureIfWrongKsh: 10_000,
  },
  "case-2-wrong-seller-zerosum": {
    expectedVerdict: "CORRECTED_READY_FOR_APPROVAL",
    expectedDebitSeller: "SELLER-A",
    exposureIfWrongKsh: 10_000,
  },
  "case-3-missing-evidence": {
    expectedVerdict: "HOLD_MISSING_EVIDENCE",
    expectedDebitSeller: null,
    exposureIfWrongKsh: 10_000,
  },
  "case-4-late-correction-midflight": {
    expectedVerdict: "CORRECTED_READY_FOR_APPROVAL",
    expectedDebitSeller: "SELLER-A",
    exposureIfWrongKsh: 10_000,
  },
  "case-5-chargeback-collision": {
    expectedVerdict: "FROZEN_DISPUTE_COLLISION",
    expectedDebitSeller: null,
    exposureIfWrongKsh: 10_000,
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

async function main(): Promise<void> {
  console.log("=== RefundGuard vs. Single-Agent Sequential Baseline ===\n");

  let baselinePassed = 0;
  let guardPassed = 0;
  let baselineLeakedKsh = 0;
  let guardLeakedKsh = 0;
  let guardOverlapCount = 0;

  const rows: Array<Record<string, string>> = [];

  for (const scenario of SCENARIOS) {
    const truth = GROUND_TRUTH[scenario.id];
    const [baseline, guard] = await Promise.all([
      runSingleAgentBaseline(scenario, { latencyScale: 0.5 }),
      runRefundGuardCase(scenario, { latencyScale: 0.5 }),
    ]);

    const baseOk = isCorrectOutcome(baseline, truth);
    const guardOk = isCorrectOutcome(guard, truth);

    if (baseOk) baselinePassed += 1;
    else baselineLeakedKsh += truth.exposureIfWrongKsh;

    if (guardOk) guardPassed += 1;
    else guardLeakedKsh += truth.exposureIfWrongKsh;

    if (guard.concurrentOverlapVerified) guardOverlapCount += 1;

    rows.push({
      Scenario: scenario.shortLabel,
      "Baseline Verdict": `${baseOk ? "PASS" : "FAIL"} (${baseline.acceptedProposal?.debitSellerId ?? baseline.verdict})`,
      "RefundGuard Verdict": `${guardOk ? "PASS" : "FAIL"} (${guard.verdict})`,
      Interceptions: guard.interceptions.map((i) => i.reason).join("+") || "none",
      "Concurrent Overlap": guard.concurrentOverlapVerified ? "YES" : "NO",
      "Baseline Leakage": baseOk ? "KSh 0" : formatKsh(truth.exposureIfWrongKsh),
      "RefundGuard Leakage": guardOk ? "KSh 0" : formatKsh(truth.exposureIfWrongKsh),
    });
  }

  console.table(rows);
  console.log("Summary:");
  console.log(
    `  Single-Agent Baseline: ${baselinePassed}/${SCENARIOS.length} correct | Financial error/leakage: ${formatKsh(baselineLeakedKsh)}`,
  );
  console.log(
    `  RefundGuard (Mozaik):  ${guardPassed}/${SCENARIOS.length} correct | Financial error/leakage: ${formatKsh(guardLeakedKsh)} | Verified concurrent overlap: ${guardOverlapCount}/${SCENARIOS.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
