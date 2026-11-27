import { createHuman, SemanticEvent } from "@mozaik-ai/core";
import { checkMoneyReconciliation, computeGroundedLedger } from "../finance/ledger.js";
import {
  isVerdictApprovable,
  type CaseRunReport,
  type ChargebackWebhookRecord,
  type DisputeMatchState,
  type FinalVerdict,
  type MidFlightInjection,
  type ScenarioFixture,
  type SellerId,
  type WarehouseNoteRecord,
} from "../finance/types.js";
import { createAuditObserver } from "../mozaik/agents/observer.js";
import { createRefundDeskAgent } from "../mozaik/agents/refund-desk.js";
import { createSentinelAgent } from "../mozaik/agents/sentinel.js";
import { validateSentinelFindingForClearance } from "../mozaik/interception.js";
import { resolveInferenceMode } from "../mozaik/runner.js";
import {
  createRefundGuardRuntime,
  RefundGuardState,
  type TimelineListener,
} from "../mozaik/runtime.js";

export interface PostAcceptanceInjector {
  injectWarehouseCorrection(note: WarehouseNoteRecord): {
    epoch: number;
    invalidatedPriorApproval: boolean;
  };
  injectChargeback(chargeback: ChargebackWebhookRecord): {
    relevant: boolean;
    epoch: number;
    invalidatedPriorApproval: boolean;
  };
  getCurrentSnapshot(): {
    epoch: number;
    verdict: FinalVerdict;
    approvable: boolean;
    reconciliationMatched: boolean;
    report: CaseRunReport;
  };
}

export interface RunCaseOptions {
  modeOverride?: "auto" | "live" | "mock";
  latencyScale?: number;
  customWarehouseNoteText?: string;
  overrideDraftSellerId?: SellerId;
  overrideInjection?: MidFlightInjection | null;
  allowPostAcceptanceRevalidation?: boolean;
  onTimeline?: TimelineListener;
  /**
   * Event-driven hook invoked synchronously the first time `proposal.accepted` fires,
   * allowing deterministic tests of post-acceptance updates without fixed delays.
   */
  onProposalAccepted?: (injector: PostAcceptanceInjector) => void;
  /**
   * Invoked once the Mozaik runtime is joined and ready, returning live injector
   * and snapshot callbacks that can interrupt the session mid-run or post-run.
   */
  onSessionReady?: (injector: PostAcceptanceInjector) => void;
}

/**
 * Execute a full concurrent Mozaik RefundGuard review on a scenario.
 */
export async function runRefundGuardCase(
  baseScenario: ScenarioFixture,
  options: RunCaseOptions = {},
): Promise<CaseRunReport> {
  const scenario = applyScenarioOverrides(baseScenario, options);
  const latencyScale = options.latencyScale ?? 1;
  const resolved = resolveInferenceMode({
    modeOverride: options.modeOverride,
    latencyScale,
  });

  const runtime = createRefundGuardRuntime();
  const state = new RefundGuardState(
    scenario,
    resolved.mode,
    resolved.modelName,
    options.allowPostAcceptanceRevalidation ?? true,
  );
  if (options.onTimeline) {
    state.onTimeline(options.onTimeline);
  }

  runtime.initializeRuntime({
    state,
    inferenceRunnerConfig: resolved.inferenceRunnerConfig,
  });

  const coordinator = createHuman({
    name: "OperatorFeed",
    capabilities: ["case-intake", "webhook-ingest"],
    handlers: [],
  });
  const refundDesk = createRefundDeskAgent(runtime, state);
  const sentinel = createSentinelAgent(runtime, state);
  const observer = createAuditObserver(state, refundDesk.getId(), sentinel.getId());

  runtime.join(coordinator);
  runtime.join(refundDesk);
  runtime.join(sentinel);
  runtime.join(observer);

  const buildCurrentReport = (): CaseRunReport => {
    const latestRelevantDispute = state.getLatestRelevantChargeback();
    const currentEpochFinding = state.getLatestSentinelFinding();
    const finalVerdict = resolveFinalVerdictWithInvariant(
      state,
      latestRelevantDispute?.evaluation.matchState ?? null,
      currentEpochFinding,
    );

    const isApproved = isVerdictApprovable(finalVerdict);
    const acceptedForCurrentEpoch =
      isApproved && state.acceptedProposal?.epoch === state.epoch
        ? state.acceptedProposal
        : null;

    const supportedDebitSellerId = acceptedForCurrentEpoch?.debitSellerId ?? null;

    const ledger = computeGroundedLedger(
      scenario,
      finalVerdict,
      supportedDebitSellerId,
      currentEpochFinding ?? state.getMostRecentAnyEpochFinding(),
      latestRelevantDispute?.evaluation ?? state.lastDisputeEvaluation,
    );
    const overlap = state.computeOverlapMetrics();

    return {
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      mode: resolved.mode,
      modelName: resolved.modelName,
      architecture: "refund-guard-concurrent",
      verdict: finalVerdict,
      finalEpoch: state.epoch,
      durationMs: state.elapsedMs(),
      concurrentOverlapVerified: overlap.overlapped,
      overlapDetail: overlap.detail,
      sentinelFinding: currentEpochFinding ?? state.getMostRecentAnyEpochFinding(),
      disputeEvaluation: latestRelevantDispute?.evaluation ?? state.lastDisputeEvaluation,
      acceptedProposal: acceptedForCurrentEpoch,
      supersededProposals: [...state.supersededProposals],
      interceptions: [...state.interceptions],
      ledger,
      timeline: [...state.timeline],
    };
  };

  let runCompleted = false;

  const publishWarehouseCorrection = (note: WarehouseNoteRecord) => {
    const { epoch, invalidatedPriorApproval } = state.addWarehouseCorrection(note);
    if (!runCompleted) {
      runtime.sendEvent(
        SemanticEvent.create("evidence.updated", coordinator.getId(), {
          epoch,
          kind: "WAREHOUSE_CORRECTION",
          sourceId: note.noteId,
          invalidatedPriorApproval,
        }),
        coordinator.getId(),
      );
    }
    return { epoch, invalidatedPriorApproval };
  };

  const publishChargeback = (chargeback: ChargebackWebhookRecord) => {
    const res = state.addChargebackWebhook(chargeback);
    if (!res.relevant) {
      return {
        relevant: false,
        epoch: res.epoch,
        invalidatedPriorApproval: false,
      };
    }
    const disputeClosed = res.evaluation.matchState === "INACTIVE";
    if (!runCompleted) {
      runtime.sendEvent(
        SemanticEvent.create("evidence.updated", coordinator.getId(), {
          epoch: res.epoch,
          kind: "CHARGEBACK_WEBHOOK",
          sourceId: chargeback.disputeId,
          invalidatedPriorApproval: res.invalidatedPriorApproval,
          disputeClosed,
        }),
        coordinator.getId(),
      );
    }
    return {
      relevant: true,
      epoch: res.epoch,
      invalidatedPriorApproval: res.invalidatedPriorApproval,
    };
  };

  const liveInjector: PostAcceptanceInjector = {
    injectWarehouseCorrection: publishWarehouseCorrection,
    injectChargeback: publishChargeback,
    getCurrentSnapshot: () => {
      const report = buildCurrentReport();
      return {
        epoch: report.finalEpoch,
        verdict: report.verdict,
        approvable:
          isVerdictApprovable(report.verdict) && report.ledger.reconciliationMatched,
        reconciliationMatched: report.ledger.reconciliationMatched,
        report,
      };
    },
  };

  options.onSessionReady?.(liveInjector);

  if (options.onProposalAccepted) {
    let fired = false;
    state.onTimeline((entry) => {
      if (!fired && entry.type === "proposal.accepted") {
        fired = true;
        options.onProposalAccepted?.(liveInjector);
      }
    });
  }

  state.recordEvent(
    "case.opened",
    "OperatorFeed",
    `Opened ${scenario.id} (${scenario.checkoutId}, batch ${scenario.batchId}, draft debits ${scenario.draft.debitedSellerId}, net total KSh ${scenario.draft.totalBatchSettlementKsh.toLocaleString("en-KE")}).`,
    {
      scenarioId: scenario.id,
      mode: resolved.mode,
      model: resolved.modelName,
      draftDebitedSellerId: scenario.draft.debitedSellerId,
    },
  );

  let injectionTimer: ReturnType<typeof setTimeout> | undefined;
  if (scenario.midFlightInjection) {
    const inj = scenario.midFlightInjection;
    const delayMs = Math.max(20, Math.round(inj.delayMs * latencyScale));
    injectionTimer = setTimeout(() => {
      if (inj.kind === "WAREHOUSE_CORRECTION" && inj.warehouseNote) {
        publishWarehouseCorrection(inj.warehouseNote);
      } else if (inj.kind === "CHARGEBACK_WEBHOOK" && inj.chargeback) {
        publishChargeback(inj.chargeback);
      }
    }, delayMs);
  }

  // Publish `case.opened`. Mozaik fans it out synchronously to both agents,
  // launching two concurrent non-blocking runLoops immediately.
  runtime.sendEvent(
    SemanticEvent.create("case.opened", coordinator.getId(), {
      scenarioId: scenario.id,
      epoch: state.epoch,
    }),
    coordinator.getId(),
  );

  try {
    await state.waitUntilComplete(resolved.mode === "live" ? 45_000 : 12_000);
  } finally {
    runCompleted = true;
    if (injectionTimer) clearTimeout(injectionTimer);
  }

  return buildCurrentReport();
}

function resolveFinalVerdictWithInvariant(
  state: RefundGuardState,
  relevantDisputeMatchState: DisputeMatchState | null,
  currentEpochFinding: ReturnType<RefundGuardState["getLatestSentinelFinding"]>,
): FinalVerdict {
  if (
    relevantDisputeMatchState === "VERIFIED_ACTIVE_MATCH" ||
    relevantDisputeMatchState === "VERIFIED_LOST_DISPUTE"
  ) {
    return "FROZEN_DISPUTE_COLLISION";
  }
  if (
    relevantDisputeMatchState === "AMBIGUOUS_MATCH" ||
    currentEpochFinding?.status === "DISPUTE_AMBIGUOUS"
  ) {
    return "VERIFY_DISPUTE_MATCH";
  }

  // Deterministic money reconciliation must pass before ANY payout can be marked ready.
  const recon = checkMoneyReconciliation(
    state.scenario,
    state.acceptedProposal?.refundAmountKsh,
  );
  if (!recon.ok) {
    return "HOLD_RECONCILIATION_MISMATCH";
  }

  if (currentEpochFinding?.status === "MISSING_OR_AMBIGUOUS") {
    return "HOLD_MISSING_EVIDENCE";
  }

  const findingCheck = validateSentinelFindingForClearance(state, currentEpochFinding);
  const proposal = state.acceptedProposal;
  const currentReady =
    findingCheck.valid &&
    currentEpochFinding !== null &&
    proposal !== null &&
    proposal.epoch === state.epoch &&
    proposal.checkoutId === state.scenario.checkoutId &&
    proposal.refundAmountKsh === recon.expectedRefundKsh &&
    currentEpochFinding.verifiedSellerId === proposal.debitSellerId;

  if (currentReady) {
    const wasCorrected =
      state.interceptions.length > 0 ||
      state.supersededProposals.length > 0 ||
      proposal.debitSellerId !== state.scenario.draft.debitedSellerId;
    return wasCorrected ? "CORRECTED_READY_FOR_APPROVAL" : "READY_FOR_HUMAN_APPROVAL";
  }

  if (state.revalidationRequestedForEpoch !== null || state.supersededProposals.length > 0) {
    return "PENDING_REVALIDATION";
  }

  if (state.verdict === "HOLD_RECONCILIATION_MISMATCH") {
    return "HOLD_RECONCILIATION_MISMATCH";
  }
  return state.verdict === "HOLD_MISSING_EVIDENCE"
    ? "HOLD_MISSING_EVIDENCE"
    : "PENDING_REVALIDATION";
}

function applyScenarioOverrides(
  base: ScenarioFixture,
  options: RunCaseOptions,
): ScenarioFixture {
  let draft = base.draft;
  if (options.overrideDraftSellerId && options.overrideDraftSellerId !== base.draft.debitedSellerId) {
    const newSeller = options.overrideDraftSellerId;
    const refund = base.draft.refundAmountKsh;
    draft = {
      ...base.draft,
      debitedSellerId: newSeller,
      sellerLines: base.draft.sellerLines.map((line) => {
        const deduction = line.sellerId === newSeller ? refund : 0;
        return {
          ...line,
          refundDeductionKsh: deduction,
          netPayoutKsh: line.grossSalesKsh - deduction,
        };
      }),
    };
  }

  let initialWarehouseNote: WarehouseNoteRecord = base.initialWarehouseNote;
  if (
    typeof options.customWarehouseNoteText === "string" &&
    options.customWarehouseNoteText.trim().length > 0 &&
    options.customWarehouseNoteText.trim() !== base.initialWarehouseNote.text.trim()
  ) {
    initialWarehouseNote = {
      ...base.initialWarehouseNote,
      noteId: `${base.initialWarehouseNote.noteId}-EDIT`,
      text: options.customWarehouseNoteText.trim(),
    };
  }

  const midFlightInjection =
    options.overrideInjection === undefined
      ? base.midFlightInjection
      : (options.overrideInjection ?? undefined);

  return {
    ...base,
    draft,
    initialWarehouseNote,
    midFlightInjection,
  };
}

export function buildInjectedChargeback(scenario: ScenarioFixture): ChargebackWebhookRecord {
  const capture = scenario.settlements.find((s) => s.kind === "CAPTURE");
  return {
    disputeId: `DSP-LIVE-${Date.now().toString().slice(-4)}`,
    status: "OPEN",
    receivedAt: new Date().toISOString(),
    pspReferenceSuffix: scenario.checkoutId.split("-").pop() ?? scenario.checkoutId.slice(-3),
    paymentSettlementId: capture?.settlementId ?? "STL-PAY-402",
    cardLast4: capture?.cardLast4 ?? "4421",
    amountKsh: scenario.ticket.requestedRefundKsh,
    reasonCode: "VISA_13.3_NOT_AS_DESCRIBED_OR_DEFECTIVE",
    narrative: `Live injected issuing-bank dispute on card ending ${capture?.cardLast4 ?? "4421"} for KSh ${scenario.ticket.requestedRefundKsh.toLocaleString("en-KE")} (checkout ref ${scenario.checkoutId}, settlement ${capture?.settlementId ?? "STL-PAY-402"}).`,
  };
}

export function buildInjectedWarehouseCorrection(
  scenario: ScenarioFixture,
  targetSellerId: SellerId,
): WarehouseNoteRecord {
  const line = scenario.orderLines.find((l) => l.sellerId === targetSellerId);
  const otherLine = scenario.orderLines.find((l) => l.sellerId !== targetSellerId);
  const sellerName = scenario.sellers[targetSellerId].name;
  const itemText = line
    ? `${line.itemTitle} (SKU ${line.sku}, ${sellerName} / ${targetSellerId}). ${otherLine ? `${otherLine.itemTitle} was NOT returned.` : ""}`
    : targetSellerId === "SELLER-A"
      ? "Navy Quilted Winter Jacket (SKU JKT-NVY-L, Nairobi Streetwear / Seller A). Boots were NOT returned."
      : "Tan Leather Chelsea Boots (SKU BTS-TAN-42, Rift Valley Footwear / Seller B). Jacket was NOT returned.";

  return {
    noteId: `WH-CORR-${Date.now().toString().slice(-4)}`,
    receivedAt: new Date().toISOString(),
    hub: "Kisumu Returns Hub (Live QC Override)",
    supersedesNoteId: scenario.initialWarehouseNote.noteId,
    text: `CORRECTION superseding ${scenario.initialWarehouseNote.noteId}: Bench inspection confirmed physical return is ${itemText}`,
  };
}
