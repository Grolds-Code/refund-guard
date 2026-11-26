import { createHuman, SemanticEvent } from "@mozaik-ai/core";
import { computeGroundedLedger } from "../finance/ledger.js";
import type {
  CaseRunReport,
  ChargebackWebhookRecord,
  FinalVerdict,
  MidFlightInjection,
  ScenarioFixture,
  SellerId,
  WarehouseNoteRecord,
} from "../finance/types.js";
import { createAuditObserver } from "../mozaik/agents/observer.js";
import { createRefundDeskAgent } from "../mozaik/agents/refund-desk.js";
import { createSentinelAgent } from "../mozaik/agents/sentinel.js";
import { resolveInferenceMode } from "../mozaik/runner.js";
import {
  createRefundGuardRuntime,
  RefundGuardState,
  type TimelineListener,
} from "../mozaik/runtime.js";

export interface PostAcceptanceInjector {
  injectWarehouseCorrection(note: WarehouseNoteRecord): void;
  injectChargeback(chargeback: ChargebackWebhookRecord): void;
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

  const publishWarehouseCorrection = (note: WarehouseNoteRecord) => {
    const { epoch, invalidatedPriorApproval } = state.addWarehouseCorrection(note);
    runtime.sendEvent(
      SemanticEvent.create("evidence.updated", coordinator.getId(), {
        epoch,
        kind: "WAREHOUSE_CORRECTION",
        sourceId: note.noteId,
        invalidatedPriorApproval,
      }),
      coordinator.getId(),
    );
  };

  const publishChargeback = (chargeback: ChargebackWebhookRecord) => {
    const res = state.addChargebackWebhook(chargeback);
    if (!res.relevant) {
      // Unrelated or inactive disputes must not bump epoch or disturb clean checkouts.
      return;
    }
    runtime.sendEvent(
      SemanticEvent.create("evidence.updated", coordinator.getId(), {
        epoch: res.epoch,
        kind: "CHARGEBACK_WEBHOOK",
        sourceId: chargeback.disputeId,
        invalidatedPriorApproval: res.invalidatedPriorApproval,
      }),
      coordinator.getId(),
    );
  };

  if (options.onProposalAccepted) {
    let fired = false;
    state.onTimeline((entry) => {
      if (!fired && entry.type === "proposal.accepted") {
        fired = true;
        options.onProposalAccepted?.({
          injectWarehouseCorrection: publishWarehouseCorrection,
          injectChargeback: publishChargeback,
        });
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

  // Schedule any mid-flight event (late warehouse correction or async PSP dispute)
  // so it arrives while RefundDeskAgent is actively running.
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
    if (injectionTimer) clearTimeout(injectionTimer);
  }

  // Strict readiness invariant: never return a ready verdict unless both the accepted
  // proposal and the verified Sentinel finding belong to the current epoch and no
  // active or ambiguous dispute applies.
  const latestRelevantDispute = state.getLatestRelevantChargeback();
  const currentEpochFinding = state.getLatestSentinelFinding();
  const finalVerdict = resolveFinalVerdictWithInvariant(
    state,
    latestRelevantDispute?.evaluation.matchState ?? null,
    currentEpochFinding,
  );

  const isApproved =
    finalVerdict === "READY_FOR_HUMAN_APPROVAL" ||
    finalVerdict === "CORRECTED_READY_FOR_APPROVAL";

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
    supersededProposals: state.supersededProposals,
    interceptions: state.interceptions,
    ledger,
    timeline: state.timeline,
  };
}

function resolveFinalVerdictWithInvariant(
  state: RefundGuardState,
  relevantDisputeMatchState: "VERIFIED_ACTIVE_MATCH" | "AMBIGUOUS_MATCH" | "UNRELATED" | "INACTIVE" | null,
  currentEpochFinding: ReturnType<RefundGuardState["getLatestSentinelFinding"]>,
): FinalVerdict {
  if (relevantDisputeMatchState === "VERIFIED_ACTIVE_MATCH") {
    return "FROZEN_DISPUTE_COLLISION";
  }
  if (
    relevantDisputeMatchState === "AMBIGUOUS_MATCH" ||
    currentEpochFinding?.status === "DISPUTE_AMBIGUOUS"
  ) {
    return "VERIFY_DISPUTE_MATCH";
  }
  if (currentEpochFinding?.status === "MISSING_OR_AMBIGUOUS") {
    return "HOLD_MISSING_EVIDENCE";
  }

  const proposal = state.acceptedProposal;
  const currentReady =
    proposal !== null &&
    proposal.epoch === state.epoch &&
    currentEpochFinding !== null &&
    currentEpochFinding.epoch === state.epoch &&
    currentEpochFinding.status === "VERIFIED_RETURN" &&
    currentEpochFinding.verifiedSellerId === proposal.debitSellerId;

  if (currentReady) {
    const wasCorrected =
      state.interceptions.length > 0 ||
      state.supersededProposals.length > 0 ||
      proposal.debitSellerId !== state.scenario.draft.debitedSellerId;
    return wasCorrected ? "CORRECTED_READY_FOR_APPROVAL" : "READY_FOR_HUMAN_APPROVAL";
  }

  // If an earlier proposal was invalidated by newer evidence and revalidation could
  // not complete for the current epoch, fail closed to PENDING_REVALIDATION.
  if (state.revalidationRequestedForEpoch !== null || state.supersededProposals.length > 0) {
    return "PENDING_REVALIDATION";
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
    pspReferenceSuffix: scenario.checkoutId.slice(-3),
    paymentSettlementId: capture?.settlementId ?? "STL-PAY-402",
    cardLast4: capture?.cardLast4 ?? "4421",
    amountKsh: scenario.ticket.requestedRefundKsh,
    reasonCode: "VISA_13.1_MERCHANDISE_NOT_RECEIVED",
    narrative: `Live injected issuing-bank dispute on card ending ${capture?.cardLast4 ?? "4421"} for KSh ${scenario.ticket.requestedRefundKsh.toLocaleString("en-KE")} (checkout ref ending ${scenario.checkoutId.slice(-3)}, settlement ${capture?.settlementId ?? "STL-PAY-402"}).`,
  };
}

export function buildInjectedWarehouseCorrection(
  scenario: ScenarioFixture,
  targetSellerId: SellerId,
): WarehouseNoteRecord {
  const itemText =
    targetSellerId === "SELLER-A"
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
