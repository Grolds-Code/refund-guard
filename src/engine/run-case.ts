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

export interface RunCaseOptions {
  modeOverride?: "auto" | "live" | "mock";
  latencyScale?: number;
  customWarehouseNoteText?: string;
  overrideDraftSellerId?: SellerId;
  overrideInjection?: MidFlightInjection | null;
  onTimeline?: TimelineListener;
}

/**
 * Execute a full concurrent Mozaik RefundGuard review on a scenario (optionally
 * modified live by a judge in the UI or test suite).
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
  const state = new RefundGuardState(scenario, resolved.mode, resolved.modelName);
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

  // Schedule any mid-flight event (late warehouse correction or async PSP chargeback)
  // so it arrives while RefundDeskAgent is actively running!
  let injectionTimer: ReturnType<typeof setTimeout> | undefined;
  if (scenario.midFlightInjection) {
    const inj = scenario.midFlightInjection;
    const delayMs = Math.max(20, Math.round(inj.delayMs * latencyScale));
    injectionTimer = setTimeout(() => {
      if (inj.kind === "WAREHOUSE_CORRECTION" && inj.warehouseNote) {
        const newEpoch = state.addWarehouseCorrection(inj.warehouseNote);
        runtime.sendEvent(
          SemanticEvent.create("evidence.updated", coordinator.getId(), {
            epoch: newEpoch,
            kind: "WAREHOUSE_CORRECTION",
            sourceId: inj.warehouseNote.noteId,
          }),
          coordinator.getId(),
        );
      } else if (inj.kind === "CHARGEBACK_WEBHOOK" && inj.chargeback) {
        const newEpoch = state.addChargebackWebhook(inj.chargeback);
        runtime.sendEvent(
          SemanticEvent.create("evidence.updated", coordinator.getId(), {
            epoch: newEpoch,
            kind: "CHARGEBACK_WEBHOOK",
            sourceId: inj.chargeback.disputeId,
          }),
          coordinator.getId(),
        );
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

  const finalVerdict: FinalVerdict = state.verdict ?? "HOLD_MISSING_EVIDENCE";
  const latestFinding = state.getLatestSentinelFinding() ?? state.getMostRecentAnyEpochFinding();
  const supportedDebitSellerId =
    finalVerdict === "READY_FOR_HUMAN_APPROVAL" ||
    finalVerdict === "CORRECTED_READY_FOR_APPROVAL"
      ? (state.acceptedProposal?.debitSellerId ?? latestFinding?.verifiedSellerId ?? null)
      : null;

  const ledger = computeGroundedLedger(
    scenario,
    finalVerdict,
    supportedDebitSellerId,
    latestFinding,
  );
  const overlap = state.computeOverlapMetrics();

  return {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    mode: resolved.mode,
    architecture: "refund-guard-concurrent",
    verdict: finalVerdict,
    finalEpoch: state.epoch,
    durationMs: state.elapsedMs(),
    concurrentOverlapVerified: overlap.overlapped,
    overlapDetail: overlap.detail,
    sentinelFinding: latestFinding,
    acceptedProposal: state.acceptedProposal,
    interceptions: state.interceptions,
    ledger,
    timeline: state.timeline,
  };
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
  return {
    disputeId: `DSP-LIVE-${Date.now().toString().slice(-4)}`,
    receivedAt: new Date().toISOString(),
    pspReferenceSuffix: scenario.checkoutId.slice(-3),
    cardLast4: scenario.settlements[0]?.cardLast4 ?? "4421",
    amountKsh: scenario.ticket.requestedRefundKsh,
    reasonCode: "VISA_13.1_MERCHANDISE_NOT_RECEIVED",
    narrative: `Live injected issuing-bank chargeback on card ending ${scenario.settlements[0]?.cardLast4 ?? "4421"} for KSh ${scenario.ticket.requestedRefundKsh.toLocaleString("en-KE")} (checkout ref ending ${scenario.checkoutId.slice(-3)}).`,
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
