import { defineRuntime, RuntimeState, type SemanticEvent } from "@mozaik-ai/core";
import type {
  ChargebackWebhookRecord,
  FinalVerdict,
  InterceptionRecord,
  ProposedRefundAction,
  ScenarioFixture,
  SentinelFinding,
  TimelineEntry,
  WarehouseNoteRecord,
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
  public acceptedProposal: ProposedRefundAction | null = null;
  public verdict: FinalVerdict | null = null;
  public refundDeskFinished = false;
  public sentinelPendingCount = 0;

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
  ) {
    super();
    this.startedAtMs = Date.now();
    this.warehouseNotes = [scenario.initialWarehouseNote];
    this.chargebacks = scenario.initialChargeback ? [scenario.initialChargeback] : [];
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

  getLatestChargeback(): ChargebackWebhookRecord | null {
    return this.chargebacks.length > 0
      ? this.chargebacks[this.chargebacks.length - 1]
      : null;
  }

  addWarehouseCorrection(note: WarehouseNoteRecord): number {
    this.epoch += 1;
    this.warehouseNotes.push(note);
    this.recordEvent(
      "evidence.warehouse_updated",
      "WarehouseFeed",
      `Late warehouse correction ${note.noteId} arrived (epoch → ${this.epoch}): ${note.text}`,
      { noteId: note.noteId, epoch: this.epoch },
    );
    return this.epoch;
  }

  addChargebackWebhook(chargeback: ChargebackWebhookRecord): number {
    this.epoch += 1;
    this.chargebacks.push(chargeback);
    this.recordEvent(
      "evidence.chargeback_arrived",
      "PSPWebhook",
      `Asynchronous bank chargeback ${chargeback.disputeId} (${chargeback.reasonCode}) arrived (epoch → ${this.epoch})`,
      { disputeId: chargeback.disputeId, amountKsh: chargeback.amountKsh, epoch: this.epoch },
    );
    return this.epoch;
  }

  publishSentinelFinding(finding: SentinelFinding): void {
    this.sentinelFindings.set(finding.epoch, finding);
    this.recordEvent(
      "sentinel.finding",
      "DisputeFulfillmentSentinel",
      `[epoch ${finding.epoch}] ${finding.status}${finding.verifiedSellerId ? ` → ${finding.verifiedSellerId} (${finding.verifiedLineId})` : ""}${finding.disputeId ? ` [dispute ${finding.disputeId}]` : ""}: ${finding.summary}`,
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

  async waitForSentinelForCurrentEpoch(timeoutMs = 8_000): Promise<SentinelFinding | null> {
    const targetEpoch = this.epoch;
    const existing = this.sentinelFindings.get(targetEpoch);
    if (existing) {
      return existing;
    }

    return new Promise<SentinelFinding | null>((resolve) => {
      const timer = setTimeout(() => {
        resolve(this.sentinelFindings.get(this.epoch) ?? this.getMostRecentAnyEpochFinding());
      }, timeoutMs);

      const list = this.epochWaiters.get(targetEpoch) ?? [];
      list.push((finding) => {
        clearTimeout(timer);
        resolve(finding);
      });
      this.epochWaiters.set(targetEpoch, list);
    });
  }

  markRefundDeskFinished(verdict?: FinalVerdict): void {
    if (verdict && !this.verdict) {
      this.verdict = verdict;
    }
    this.refundDeskFinished = true;
    this.checkCompletion();
  }

  notifySentinelLoopSettled(): void {
    this.sentinelPendingCount = Math.max(0, this.sentinelPendingCount - 1);
    this.checkCompletion();
  }

  private checkCompletion(): void {
    if (this.refundDeskFinished && this.sentinelPendingCount === 0) {
      const resolvers = this.doneResolvers;
      this.doneResolvers = [];
      for (const r of resolvers) {
        r();
      }
    }
  }

  waitUntilComplete(timeoutMs = 20_000): Promise<void> {
    if (this.refundDeskFinished && this.sentinelPendingCount === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `RefundGuard session timed out after ${timeoutMs}ms (refundDeskFinished=${this.refundDeskFinished}, sentinelPending=${this.sentinelPendingCount})`,
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
};

export type RefundGuardEvent =
  | SemanticEvent<"case.opened", CaseOpenedPayload>
  | SemanticEvent<"evidence.updated", EvidenceUpdatedPayload>;
