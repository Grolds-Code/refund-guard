import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getScenarioById } from "./finance/fixtures.js";
import { buildInjectedWarehouseCorrection, runRefundGuardCase } from "./engine/run-case.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACE_OUT = join(__dirname, "..", "traces", "live-run-trace.json");

/**
 * Live-model verification harness.
 * Requires OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in `.env` or environment.
 *
 * Usage:
 *   node --import tsx src/live-trace.ts [scenarioId] [--post-acceptance]
 *
 * Default: runs `case-4-late-correction-midflight` with `--post-acceptance` so a real LLM
 * first accepts Seller B on epoch 1 (WH-404-V1), then receives the QC warehouse correction
 * (WH-404-V2) which expires the epoch-1 acceptance (`readiness.invalidated`), moves Seller B
 * into `supersededProposals`, and revalidates concurrently to Seller A on epoch 2 with zero
 * duplicate acceptances in any epoch.
 */
async function main(): Promise<void> {
  const hasKey = Boolean(
    process.env.OPENAI_API_KEY?.trim() ||
      process.env.ANTHROPIC_API_KEY?.trim() ||
      process.env.GEMINI_API_KEY?.trim(),
  );

  if (!hasKey) {
    console.error(
      "Live model verification requires OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in .env or the environment.",
    );
    console.error("For reproducible zero-key verification, run `npm test` or `npm run compare`.");
    process.exit(2);
  }

  const args = process.argv.slice(2);
  const scenarioId =
    args.find((a) => !a.startsWith("--")) ?? "case-4-late-correction-midflight";
  const postAcceptanceMode =
    args.includes("--post-acceptance") ||
    (args.length === 0 && scenarioId === "case-4-late-correction-midflight");

  const scenario = getScenarioById(scenarioId);

  console.log(
    `Running live Mozaik trace on ${scenario.id}${postAcceptanceMode ? " (post-acceptance expiry mode)" : ""}...`,
  );

  const report = await runRefundGuardCase(scenario, {
    modeOverride: "live",
    latencyScale: 1,
    // In post-acceptance mode, disable the fixed 110ms timer and instead inject WH-404-V2
    // immediately when epoch-1 acceptance fires, proving live expiration of an accepted approval.
    overrideInjection: postAcceptanceMode ? null : undefined,
    onProposalAccepted: postAcceptanceMode
      ? ({ injectWarehouseCorrection }) => {
          const note =
            scenario.midFlightInjection?.warehouseNote ??
            buildInjectedWarehouseCorrection(scenario, "SELLER-A");
          injectWarehouseCorrection(note);
        }
      : undefined,
  });

  const acceptEvents = report.timeline.filter((e) => e.type === "proposal.accepted");
  const acceptCountByEpoch = new Map<number, number>();
  for (const ev of acceptEvents) {
    acceptCountByEpoch.set(ev.epoch, (acceptCountByEpoch.get(ev.epoch) ?? 0) + 1);
  }
  const noDuplicateAcceptInAnyEpoch = [...acceptCountByEpoch.values()].every((n) => n <= 1);
  const sentinelPublished = report.sentinelFinding !== null;
  const deskSubmitted = report.acceptedProposal !== null;
  const expiredPriorAcceptance =
    report.supersededProposals.length > 0 &&
    report.timeline.some((e) => e.type === "readiness.invalidated");
  const wrongProposalBlocked = report.interceptions.some(
    (i) => i.reason === "WRONG_SELLER_ALLOCATION" || i.reason === "SUPERSEDED_EVIDENCE",
  );

  await mkdir(dirname(TRACE_OUT), { recursive: true });
  await writeFile(
    TRACE_OUT,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        mode: report.mode,
        modelName: report.modelName,
        postAcceptanceMode,
        checks: {
          sentinelPublished,
          deskSubmitted,
          noDuplicateAcceptInAnyEpoch,
          expiredPriorAcceptance,
          wrongProposalBlocked,
          finalEpoch: report.finalEpoch,
          supersededProposalCount: report.supersededProposals.length,
          finalDebitSellerId: report.acceptedProposal?.debitSellerId ?? null,
          reconciliationMatched: report.ledger.reconciliationMatched,
          concurrentOverlapVerified: report.concurrentOverlapVerified,
        },
        report,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`Mode: ${report.mode} | Model: ${report.modelName}`);
  console.log(
    `Verdict: ${report.verdict} | Final Epoch: ${report.finalEpoch} | Final Debit: ${report.acceptedProposal?.debitSellerId ?? "none"}`,
  );
  console.log(`Sentinel tool called:       ${sentinelPublished}`);
  console.log(`Desk tool submitted:        ${deskSubmitted}`);
  console.log(`No duplicate epoch accept:  ${noDuplicateAcceptInAnyEpoch}`);
  console.log(`Expired prior acceptance:   ${expiredPriorAcceptance} (superseded: ${report.supersededProposals.length})`);
  console.log(`Wrong proposal blocked:     ${wrongProposalBlocked}`);
  console.log(`Reconciliation matched:     ${report.ledger.reconciliationMatched}`);
  console.log(`Concurrent overlap:         ${report.concurrentOverlapVerified} (${report.overlapDetail})`);
  console.log(`Saved full trace to:        ${TRACE_OUT}`);

  if (
    !sentinelPublished ||
    !deskSubmitted ||
    !noDuplicateAcceptInAnyEpoch ||
    !report.ledger.reconciliationMatched ||
    report.acceptedProposal?.debitSellerId !== "SELLER-A"
  ) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
