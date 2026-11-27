import { BLACK_FRIDAY_BATCH_CHECKOUTS } from "../finance/batch.js";
import type { CaseRunReport } from "../finance/types.js";
import { runRefundGuardCase } from "./run-case.js";

export type OperatorDecision = "PENDING" | "APPROVED_FOR_RELEASE" | "HELD_IN_RESERVE" | "REJECTED";

export interface BatchCheckoutItem {
  readonly scenarioId: string;
  readonly checkoutId: string;
  readonly title: string;
  readonly sellersLabel: string;
  readonly report: CaseRunReport;
  readonly operatorDecision: OperatorDecision;
}

export interface BatchRunSummary {
  readonly batchId: string;
  readonly runAt: string;
  readonly durationMs: number;
  readonly checkoutCount: number;
  readonly concurrentAgentLoops: number;
  readonly allOverlapsVerified: boolean;
  readonly autoClearedCount: number;
  readonly exceptionCount: number;
  readonly totalDraftReleaseKsh: number;
  readonly totalSupportedReleaseKsh: number;
  readonly totalMisallocationsCorrectedKsh: number;
  readonly totalUnsafeRefundsBlockedKsh: number;
  readonly totalHeldReserveKsh: number;
  readonly items: readonly BatchCheckoutItem[];
}

/**
 * Run the full 4-checkout Black Friday payout batch concurrently across
 * 4 isolated Mozaik runtimes (8 concurrent agent loops active in parallel).
 */
export async function runBlackFridayBatch(options?: {
  modeOverride?: "auto" | "live" | "mock";
  latencyScale?: number;
}): Promise<BatchRunSummary> {
  const startedAt = Date.now();
  const reports = await Promise.all(
    BLACK_FRIDAY_BATCH_CHECKOUTS.map((scenario) =>
      runRefundGuardCase(scenario, {
        modeOverride: options?.modeOverride,
        latencyScale: options?.latencyScale ?? 0.6,
      }),
    ),
  );

  const items: BatchCheckoutItem[] = BLACK_FRIDAY_BATCH_CHECKOUTS.map((scenario, idx) => {
    const report = reports[idx];
    const isAutoCleared = report.verdict === "READY_FOR_HUMAN_APPROVAL";
    return {
      scenarioId: scenario.id,
      checkoutId: scenario.checkoutId,
      title: scenario.title,
      sellersLabel: `${scenario.sellers["SELLER-A"].name} / ${scenario.sellers["SELLER-B"].name}`,
      report,
      operatorDecision: isAutoCleared ? "APPROVED_FOR_RELEASE" : "PENDING",
    };
  });

  const autoClearedCount = items.filter(
    (i) => i.report.verdict === "READY_FOR_HUMAN_APPROVAL",
  ).length;
  const exceptionCount = items.length - autoClearedCount;

  return {
    batchId: "BATCH-BF-2026-01",
    runAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    checkoutCount: items.length,
    concurrentAgentLoops: items.length * 2,
    allOverlapsVerified: items.every((i) => i.report.concurrentOverlapVerified),
    autoClearedCount,
    exceptionCount,
    totalDraftReleaseKsh: items.reduce((s, i) => s + i.report.ledger.draftTotalKsh, 0),
    totalSupportedReleaseKsh: items.reduce((s, i) => s + i.report.ledger.supportedTotalKsh, 0),
    totalMisallocationsCorrectedKsh: items.reduce(
      (s, i) => s + i.report.ledger.misallocationCaughtKsh,
      0,
    ),
    totalUnsafeRefundsBlockedKsh: items.reduce(
      (s, i) => s + i.report.ledger.blockedUnsafeRefundKsh,
      0,
    ),
    totalHeldReserveKsh: items.reduce((s, i) => s + i.report.ledger.heldReserveKsh, 0),
    items,
  };
}
