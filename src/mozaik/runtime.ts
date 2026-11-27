import { defineRuntime, RuntimeState, type SemanticEvent } from "@mozaik-ai/core";
import { evaluateDisputeLink } from "../finance/dispute-match.js";
import {
  isVerdictApprovable,
  type ChargebackWebhookRecord,
  type DisputeMatchEvaluation,
  type FinalVerdict,
  type InterceptionRecord,
  type ProposedRefundAction,
  type ScenarioFixture,
  type SentinelFinding,
  type TimelineEntry,
  type WarehouseNoteRecord,
} from "../finance/types.js";

export type TimelineListener = (entry: TimelineEntry) => void;

export interface AgentRunWindow {
  startedAtMs: number;
  endedAtMs?: number;
}

/**
 * Shared mutable RuntimeState subclass for a single RefundGuard review session.
 * Both concurrent Mozaik agents, the InterceptionHandler, and the Observer
 * coordinate through this shared state and SemanticEvent fan-out.
 */
export class RefundGuardState extends RuntimeState {
  public readonly startedAtMs: number;
  public epoch = 1;
  public readonly warehouseNotes: WarehouseNoteRecord[];
  public readonly chargebacks: ChargebackWebhookRecord[];
  public readonly sentinelFindings = new Map<number, SentinelFinding>();
  public readonly interceptions: InterceptionRecord[] = [];
  public readonly timeline: TimelineEntry[] = [];
  public readonly supersededProposals: ProposedRefundAction[] = [];
  public acceptedProposal: ProposedRefundAction | null = null;
  public verdict: FinalVerdict | null = null;
  public lastDisputeEvaluation: DisputeMatchEvaluation | null = null;
  public refundDeskPendingCount = 0;
  public sentinelPendingCount = 0;
  public revalidationRequestedForEpoch: number | null = null;

  public readonly refundDeskWindows: AgentRunWindow[] = [];
  public readonly sentinelWindows: AgentRunWindow[] = [];

  private seq = 0;
  private readonly listeners = new Set<TimelineListener>();
  private readonly epochWaiters = new Map<number, Array<(finding: SentinelFinding) => void>>();
  private doneResolvers: Array<() => void> = [];

  constructor(
    public readonly scenario: ScenarioFixture,
    public readonly mode: "live" | "mock",
    public readonly modelName: string,
    public readonly allowPostAcceptanceRevalidation = true,
  ) {
    super();
    this.startedAtMs = Date.now();
    this.warehouseNotes = [scenario.initialWarehouseNote];
    this.chargebacks = [];
    if (scenario.initialChargeback) {
      const evaluation = evaluateDisputeLink(scenario, scenario.initialChargeback);
      this.lastDisputeEvaluation = evaluation;
      if (
        evaluation.matchState === "VERIFIED_ACTIVE_MATCH" ||
        evaluation.matchState === "VERIFIED_LOST_DISPUTE" ||
        evaluation.matchState === "AMBIGUOUS_MATCH"
      ) {
        this.chargebacks.push(scenario.initialChargeback);
      }
    }
  }

  elapsedMs(): number {
    return Date.now() - this.startedAtMs;
  }

  onTimeline(listener: TimelineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recordEvent(
    type: string,
    actor: string,
    message: string,
    data?: Record<string, unknown>,
  ): TimelineEntry {
    const entry: TimelineEntry = {
      seq: ++this.seq,
      elapsedMs: this.elapsedMs(),
      type,
      actor,
      epoch: this.epoch,
      message,
      data,
    };
    this.timeline.push(entry);
    for (const listener of this.listeners) {
      listener(entry);
    }
    return entry;
  }

  getLatestWarehouseNote(): WarehouseNoteRecord {
    return this.warehouseNotes[this.warehouseNotes.length - 1];
  }

  getLatestRelevantChargeback(): {
    chargeback: ChargebackWebhookRecord;
    evaluation: DisputeMatchEvaluation;
  } | null {
    let fallbackAmbiguous: {
      chargeback: ChargebackWebhookRecord;
      evaluation: DisputeMatchEvaluation;
    } | null = null;

    for (let i = this.chargebacks.length - 1; i >= 0; i -= 1) {
      const cb = this.chargebacks[i];
      const evaluation = evaluateDisputeLink(this.scenario, cb);
      if (
        evaluation.matchState === "VERIFIED_ACTIVE_MATCH" ||
        evaluation.matchState === "VERIFIED_LOST_DISPUTE"
      ) {
        this.lastDisputeEvaluation = evaluation;
        return { chargeback: cb, evaluation };
      }
      if (evaluation.matchState === "AMBIGUOUS_MATCH" && !fallbackAmbiguous) {
        fallbackAmbiguous = { chargeback: cb, evaluation };
      }
    }
    if (fallbackAmbiguous) {
      this.lastDisputeEvaluation = fallbackAmbiguous.evaluation;
      return fallbackAmbiguous;
    }
    return null;
  }

  private upsertChargeback(chargeback: ChargebackWebhookRecord): boolean {
    const existingIdx = this.chargebacks.findIndex(
      (c) => c.disputeId === chargeback.disputeId,
    );
    if (existingIdx >= 0) {
      this.chargebacks[existingIdx] = chargeback;
      return true;
    }
    this.chargebacks.push(chargeback);
    return false;
  }

  private invalidatePriorReadiness(reason: string): boolean {
    const hadAccepted = this.acceptedProposal !== null;
    if (this.acceptedProposal) {
      this.supersededProposals.push(this.acceptedProposal);
      this.acceptedProposal = null;
    }
    const hadReadyVerdict = this.verdict !== null && isVerdictApprovable(this.verdict);
    if (hadAccepted || hadReadyVerdict) {
      this.verdict = null;
      this.revalidationRequestedForEpoch = this.epoch;
      this.recordEvent(
        "readiness.invalidated",
        "RefundGuardState",
        `Prior approval invalidated at epoch ${this.epoch}: ${reason}`,
        { epoch: this.epoch, reason },
      );
      return true;
    }
    return false;
  }

  addWarehouseCorrection(note: WarehouseNoteRecord): {
    epoch: number;
    invalidatedPriorApproval: boolean;
  } {
    this.epoch += 1;
    this.warehouseNotes.push(note);
    const invalidatedPriorApproval = this.invalidatePriorReadiness(
      `warehouse correction ${note.noteId} superseded earlier evidence`,
    );
    this.recordEvent(
      "evidence.warehouse_updated",
      "WarehouseFeed",
      `Late warehouse correction ${note.noteId} arrived (epoch -> ${this.epoch}): ${note.text}`,
      { noteId: note.noteId, epoch: this.epoch, invalidatedPriorApproval },
    );
    return { epoch: this.epoch, invalidatedPriorApproval };
  }

  addChargebackWebhook(chargeback: ChargebackWebhookRecord): {
    relevant: boolean;
    epoch: number;
    evaluation: DisputeMatchEvaluation;
    invalidatedPriorApproval: boolean;
  } {
    const evaluation = evaluateDisputeLink(this.scenario, chargeback);
    this.lastDisputeEvaluation = evaluation;

    if (evaluation.matchState === "INACTIVE") {
      const existingIdx = this.chargebacks.findIndex(
        (c) => c.disputeId === chargeback.disputeId,
      );
      if (existingIdx >= 0) {
        // Apply closure (CLOSED_WON / WITHDRAWN) directly to the original dispute record
        // so the superseded OPEN record no longer blocks clearance.
        this.chargebacks[existingIdx] = chargeback;
        this.epoch += 1;
        this.recordEvent(
          "evidence.chargeback_closed",
          "PSPWebhook",
          `Dispute ${chargeback.disputeId} updated to ${chargeback.status} (epoch -> ${this.epoch}); original OPEN dispute cleared.`,
          {
            disputeId: chargeback.disputeId,
            status: chargeback.status,
            matchState: evaluation.matchState,
            epoch: this.epoch,
          },
        );
        return {
          relevant: true,
          epoch: this.epoch,
          evaluation,
          invalidatedPriorApproval: false,
        };
      }

      this.recordEvent(
        "evidence.chargeback_ignored",
        "PSPWebhook",
        `Ignored dispute ${chargeback.disputeId} (${evaluation.matchState}): ${evaluation.reason}`,
        {
          disputeId: chargeback.disputeId,
          matchState: evaluation.matchState,
          mismatchedSignals: evaluation.mismatchedSignals,
        },
      );
      return {
        relevant: false,
        epoch: this.epoch,
        evaluation,
        invalidatedPriorApproval: false,
      };
    }

    if (evaluation.matchState === "UNRELATED") {
      this.recordEvent(
        "evidence.chargeback_ignored",
        "PSPWebhook",
        `Ignored dispute ${chargeback.disputeId} (${evaluation.matchState}): ${evaluation.reason}`,
        {
          disputeId: chargeback.disputeId,
          matchState: evaluation.matchState,
          mismatchedSignals: evaluation.mismatchedSignals,
        },
      );
      return {
        relevant: false,
        epoch: this.epoch,
        evaluation,
        invalidatedPriorApproval: false,
      };
    }

    this.epoch += 1;
    this.upsertChargeback(chargeback);
    const invalidatedPriorApproval = this.invalidatePriorReadiness(
      `dispute ${chargeback.disputeId} (${evaluation.matchState}) arrived for ${this.scenario.checkoutId}`,
    );
    this.recordEvent(
      "evidence.chargeback_arrived",
      "PSPWebhook",
      `Dispute ${chargeback.disputeId} (${chargeback.reasonCode}, ${evaluation.matchState}) arrived (epoch -> ${this.epoch})`,
      {
        disputeId: chargeback.disputeId,
        amountKsh: chargeback.amountKsh,
        matchState: evaluation.matchState,
        epoch: this.epoch,
        invalidatedPriorApproval,
      },
    );
    return {
      relevant: true,
      epoch: this.epoch,
      evaluation,
      invalidatedPriorApproval,
    };
  }

  publishSentinelFinding(finding: SentinelFinding): void {
    this.sentinelFindings.set(finding.epoch, finding);
    this.recordEvent(
      "sentinel.finding",
      "DisputeFulfillmentSentinel",
      `[epoch ${finding.epoch}] ${finding.status}${finding.verifiedSellerId ? ` -> ${finding.verifiedSellerId} (${finding.verifiedLineId})` : ""}${finding.disputeId ? ` [dispute ${finding.disputeId}]` : ""}: ${finding.summary}`,
      {
        epoch: finding.epoch,
        status: finding.status,
        verifiedSellerId: finding.verifiedSellerId,
        disputeId: finding.disputeId,
        citedSourceIds: finding.citedSourceIds,
      },
    );

    const waiters = this.epochWaiters.get(finding.epoch);
    if (waiters) {
      this.epochWaiters.delete(finding.epoch);
      for (const resolve of waiters) {
        resolve(finding);
      }
    }
  }

  getLatestSentinelFinding(): SentinelFinding | null {
    return this.sentinelFindings.get(this.epoch) ?? null;
  }

  getMostRecentAnyEpochFinding(): SentinelFinding | null {
    for (let ep = this.epoch; ep >= 1; ep -= 1) {
      const found = this.sentinelFindings.get(ep);
      if (found) return found;
    }
    return null;
  }

  async waitForSentinelForCurrentEpoch(timeoutMs = 6_000): Promise<SentinelFinding | null> {
    const targetEpoch = this.epoch;
    const existing = this.sentinelFindings.get(targetEpoch);
    if (existing) {
      return existing;
    }

    return new Promise<SentinelFinding | null>((resolve) => {
      const timer = setTimeout(() => {
        const list = this.epochWaiters.get(targetEpoch);
        if (list) {
          const next = list.filter((fn) => fn !== onFinding);
          if (next.length === 0) this.epochWaiters.delete(targetEpoch);
          else this.epochWaiters.set(targetEpoch, next);
        }
        resolve(this.sentinelFindings.get(targetEpoch) ?? null);
      }, timeoutMs);

      const onFinding = (finding: SentinelFinding) => {
        clearTimeout(timer);
        resolve(finding);
      };

      const list = this.epochWaiters.get(targetEpoch) ?? [];
      list.push(onFinding);
      this.epochWaiters.set(targetEpoch, list);
    });
  }

  notifyRefundDeskLoopStarted(): void {
    this.refundDeskPendingCount += 1;
    this.refundDeskWindows.push({ startedAtMs: Date.now() });
  }

  notifyRefundDeskLoopSettled(verdict?: FinalVerdict): void {
    if (verdict && !this.verdict) {
      this.verdict = verdict;
    }
    this.refundDeskPendingCount = Math.max(0, this.refundDeskPendingCount - 1);
    this.checkCompletion();
  }

  notifySentinelLoopStarted(): void {
    this.sentinelPendingCount += 1;
    this.sentinelWindows.push({ startedAtMs: Date.now() });
  }

  notifySentinelLoopSettled(): void {
    this.sentinelPendingCount = Math.max(0, this.sentinelPendingCount - 1);
    this.checkCompletion();
  }

  private isIdle(): boolean {
    return (
      this.refundDeskWindows.length > 0 &&
      this.refundDeskPendingCount === 0 &&
      this.sentinelPendingCount === 0
    );
  }

  private checkCompletion(): void {
    if (this.isIdle()) {
      const resolvers = this.doneResolvers;
      this.doneResolvers = [];
      for (const r of resolvers) {
        r();
      }
    }
  }

  waitUntilComplete(timeoutMs = 20_000): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `RefundGuard session timed out after ${timeoutMs}ms (refundDeskPending=${this.refundDeskPendingCount}, sentinelPending=${this.sentinelPendingCount})`,
          ),
        );
      }, timeoutMs);

      this.doneResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  computeOverlapMetrics(): { overlapped: boolean; detail: string } {
    for (const r of this.refundDeskWindows) {
      const rEnd = r.endedAtMs ?? Date.now();
      for (const s of this.sentinelWindows) {
        const sEnd = s.endedAtMs ?? Date.now();
        const overlapStart = Math.max(r.startedAtMs, s.startedAtMs);
        const overlapEnd = Math.min(rEnd, sEnd);
        if (overlapEnd > overlapStart) {
          const overlapMs = overlapEnd - overlapStart;
          return {
            overlapped: true,
            detail: `RefundDesk [${r.startedAtMs - this.startedAtMs}ms..${rEnd - this.startedAtMs}ms] overlapped DisputeFulfillmentSentinel [${s.startedAtMs - this.startedAtMs}ms..${sEnd - this.startedAtMs}ms] for ${overlapMs}ms`,
          };
        }
      }
    }
    return {
      overlapped: false,
      detail: "No overlapping agent execution windows detected.",
    };
  }
}

export type RefundGuardRuntimeApi = ReturnType<typeof defineRuntime<RefundGuardState>>;

/**
 * Factory creating an isolated Mozaik runtime per review run so tests,
 * benchmark comparisons, and concurrent HTTP requests never share state.
 */
export function createRefundGuardRuntime(): RefundGuardRuntimeApi {
  return defineRuntime<RefundGuardState>();
}

export type CaseOpenedPayload = {
  scenarioId: string;
  epoch: number;
};

export type EvidenceUpdatedPayload = {
  epoch: number;
  kind: "WAREHOUSE_CORRECTION" | "CHARGEBACK_WEBHOOK";
  sourceId: string;
  invalidatedPriorApproval?: boolean;
};

export type RefundGuardEvent =
  | SemanticEvent<"case.opened", CaseOpenedPayload>
  | SemanticEvent<"evidence.updated", EvidenceUpdatedPayload>;
