import "dotenv/config";
import { getScenarioById, SCENARIOS } from "./finance/fixtures.js";
import { formatKsh } from "./finance/ledger.js";
import { runRefundGuardCase } from "./engine/run-case.js";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const targets = arg ? [getScenarioById(arg)] : SCENARIOS;

  console.log("=== RefundGuard — Concurrent Mozaik Review CLI ===\n");

  for (const scenario of targets) {
    const report = await runRefundGuardCase(scenario, { latencyScale: 0.6 });
    const sellerA = report.ledger.lines.find((l) => l.sellerId === "SELLER-A")!;
    const sellerB = report.ledger.lines.find((l) => l.sellerId === "SELLER-B")!;

    console.log(`[${scenario.id}] ${scenario.title}`);
    console.log(`  Mode:        ${report.mode} | Duration: ${report.durationMs}ms | Final Epoch: ${report.finalEpoch}`);
    console.log(`  Verdict:     ${report.verdict}`);
    console.log(`  Concurrency: ${report.concurrentOverlapVerified ? "VERIFIED" : "NONE"} — ${report.overlapDetail}`);
    console.log(`  Interceptions: ${report.interceptions.length} (${report.interceptions.map((i) => i.reason).join(", ") || "none"})`);
    console.log(
      `  Draft:       A ${formatKsh(sellerA.draftNetPayoutKsh)} / B ${formatKsh(sellerB.draftNetPayoutKsh)} (Total ${formatKsh(report.ledger.draftTotalKsh)})`,
    );
    console.log(
      `  Supported:   A ${formatKsh(sellerA.supportedNetPayoutKsh)} / B ${formatKsh(sellerB.supportedNetPayoutKsh)} (Total ${formatKsh(report.ledger.supportedTotalKsh)})`,
    );
    console.log(
      `  Protection:  Misallocation caught=${formatKsh(report.ledger.misallocationCaughtKsh)} | Double-payout blocked=${formatKsh(report.ledger.doublePayoutPreventedKsh)} | Held=${formatKsh(report.ledger.heldAmountKsh)}`,
    );
    console.log(`  Citations:   ${report.ledger.allCitations.join(", ")}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
