import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getScenarioById } from "./finance/fixtures.js";
import { runRefundGuardCase } from "./engine/run-case.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACE_OUT = join(__dirname, "..", "traces", "live-run-trace.json");

/**
 * Live-model verification harness.
 * Requires OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in `.env` or environment.
 * Runs Case 2 (Wrong-Seller Zero-Sum Trap) against a real model provider, verifies:
 * 1. Both Mozaik agents executed real tool calls (`publish_sentinel_finding` + `propose_refund`),
 * 2. RefundInterceptionGate blocked the wrong Seller B proposal, and
 * 3. RefundDeskAgent successfully submitted the revised Seller A proposal.
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

  const scenarioId = process.argv[2] ?? "case-2-wrong-seller-zerosum";
  const scenario = getScenarioById(scenarioId);

  console.log(`Running live Mozaik trace on ${scenario.id}...`);
  const report = await runRefundGuardCase(scenario, {
    modeOverride: "live",
    latencyScale: 1,
  });

  const sentinelPublished = report.sentinelFinding !== null;
  const deskSubmitted = report.acceptedProposal !== null;
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
        checks: {
          sentinelPublished,
          deskSubmitted,
          wrongProposalBlocked,
          finalDebitSellerId: report.acceptedProposal?.debitSellerId ?? null,
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
  console.log(`Verdict: ${report.verdict} | Final Debit: ${report.acceptedProposal?.debitSellerId ?? "none"}`);
  console.log(`Sentinel tool called: ${sentinelPublished}`);
  console.log(`Desk tool submitted:  ${deskSubmitted}`);
  console.log(`Wrong proposal blocked: ${wrongProposalBlocked}`);
  console.log(`Concurrent overlap:   ${report.concurrentOverlapVerified} (${report.overlapDetail})`);
  console.log(`Saved full trace to:  ${TRACE_OUT}`);

  if (!sentinelPublished || !deskSubmitted || report.acceptedProposal?.debitSellerId !== "SELLER-A") {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
