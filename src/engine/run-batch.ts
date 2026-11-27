import { BLACK_FRIDAY_BATCH_CHECKOUTS } from "../finance/batch.js";
import { isVerdictApprovable, type CaseRunReport } from "../finance/types.js";
import { runRefundGuardCase } from "./run-case.js";

export type OperatorDecision = "PENDING" | "APPROVED_FOR_RELEASE" | "HELD_IN_RESERVE" | "REJECTED";

export interface BatchCheckoutItem {
  readonly scenarioId: string;
  readonly checkoutId: string;
  readonly title: string;
  readonly sellersLabel: string;
  readonly report: CaseRunReport;
  readonly approvable: boolean;
  readonly operatorDecision: OperatorDecision;
}

export interface BatchRunSummary {
  readonly batchId: string;
  readonly runAt: string;
  readonly durationMs: number;
  readonly checkoutCount: number;
  readonly concurrentAgentLoops: number;
  readonly allOverlapsVerified: boolean;
  readonly readyForApprovalCount: number;
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
 * Run 4 distinct Black Friday checkout reviews concurrently, each running 2 parallel
 * Mozaik agent loops with measured overlap inside each checkout.
 * Every checkout starts as `operatorDecision: "PENDING"` until an operator explicitly
 * signs off (and only eligible, reconciled verdicts may be approved).
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
    const approvable =
      isVerdictApprovable(report.verdict) && report.ledger.reconciliationMatched;
    return {
      scenarioId: scenario.id,
      checkoutId: scenario.checkoutId,
      title: scenario.title,
      sellersLabel: `${scenario.sellers["SELLER-A"].name} / ${scenario.sellers["SELLER-B"].name}`,
      report,
      approvable,
      // Never pre-approve payouts before explicit human operator review.
      operatorDecision: "PENDING",
    };
  });

  const cleanReadyCount = items.filter(
    (i) => i.report.verdict === "READY_FOR_HUMAN_APPROVAL" && i.approvable,
  ).length;
  const readyForApprovalCount = items.filter((i) => i.approvable).length;
  const exceptionCount = items.length - cleanReadyCount;

  return {
    batchId: "BATCH-BF-2026-01",
    runAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    checkoutCount: items.length,
    concurrentAgentLoops: items.length * 2,
    allOverlapsVerified: items.every((i) => i.report.concurrentOverlapVerified),
    readyForApprovalCount,
    autoClearedCount: cleanReadyCount,
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
