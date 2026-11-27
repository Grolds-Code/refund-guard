import {
  Agent,
  createAgent,
  DeveloperMessageItem,
  ModelContext,
  SituationSpecification,
  type SituationContext,
  type SituationHandler,
  type Tool,
} from "@mozaik-ai/core";
import type { SellerId, SentinelEvidenceStatus } from "../../finance/types.js";
import type { RefundGuardRuntimeApi, RefundGuardState } from "../runtime.js";

class WhenEvidenceNeedsAudit extends SituationSpecification {
  isSatisfiedBy({ event }: SituationContext): boolean {
    return event.type === "case.opened" || event.type === "evidence.updated";
  }
}

const SENTINEL_INSTRUCTION =
  "You are the Dispute & Fulfillment Sentinel Agent running concurrently with the Refund Desk Agent. Parse unstructured warehouse return notes and issuing-bank dispute webhooks. Flag DISPUTE_COLLISION when an OPEN or CLOSED_LOST dispute is verified against the original payment (matching card last-4, explicit paymentSettlementId, no conflicting reference, and amount within capture). Flag DISPUTE_AMBIGUOUS when signals partially overlap or conflict. Ignore unrelated, CLOSED_WON, or WITHDRAWN disputes. Otherwise determine which exact seller line item physically arrived back at the warehouse; if no parcel arrived, contents are tentative/pending/unverified, or both items are ambiguously returned, publish status=MISSING_OR_AMBIGUOUS with confidence=LOW. Always call `publish_sentinel_finding` ONCE with the exact CURRENT_EPOCH, CHECKOUT_ID, latest WAREHOUSE_NOTE_ID, and source IDs, then reply briefly without calling the tool again.";

export function createSentinelAgent(
  runtime: RefundGuardRuntimeApi,
  state: RefundGuardState,
): Agent {
  // Provider-portable tool schema (avoids nullable array types rejected by strict LLM validators)
  const publishFindingTool: Tool = {
    type: "function",
    name: "publish_sentinel_finding",
    description:
      "Publish verified warehouse return attribution or PSP dispute findings to shared RuntimeState for the specified epoch. Use 'NONE' when a seller, line, or dispute ID does not apply.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        epoch: { type: "number" },
        checkoutId: { type: "string" },
        status: {
          type: "string",
          enum: [
            "VERIFIED_RETURN",
            "MISSING_OR_AMBIGUOUS",
            "DISPUTE_COLLISION",
            "DISPUTE_AMBIGUOUS",
          ],
        },
        verifiedSellerId: {
          type: "string",
          enum: ["SELLER-A", "SELLER-B", "NONE"],
        },
        verifiedLineId: { type: "string" },
        disputeId: { type: "string" },
        evidenceNoteId: { type: "string" },
        confidence: { type: "string", enum: ["HIGH", "LOW"] },
        summary: { type: "string" },
        citedSourceIds: { type: "array", items: { type: "string" } },
      },
      required: [
        "epoch",
        "checkoutId",
        "status",
        "verifiedSellerId",
        "verifiedLineId",
        "disputeId",
        "evidenceNoteId",
        "confidence",
        "summary",
        "citedSourceIds",
      ],
      additionalProperties: false,
    },
    invoke: async (args: {
      epoch: number;
      checkoutId?: string;
      status: SentinelEvidenceStatus;
      verifiedSellerId: SellerId | "NONE" | null;
      verifiedLineId: string | null;
      disputeId: string | null;
      evidenceNoteId: string;
      confidence: "HIGH" | "LOW";
      summary: string;
      citedSourceIds: string[];
    }) => {
      const normalizedSeller: SellerId | null =
        args.verifiedSellerId === "SELLER-A" || args.verifiedSellerId === "SELLER-B"
          ? args.verifiedSellerId
          : null;
      const normalizedLine =
        args.verifiedLineId && args.verifiedLineId !== "NONE" ? args.verifiedLineId : null;
      const normalizedDispute =
        args.disputeId && args.disputeId !== "NONE" ? args.disputeId : null;

      const finding = {
        epoch: args.epoch,
        checkoutId: args.checkoutId?.trim() || state.scenario.checkoutId,
        status: args.status,
        verifiedSellerId: normalizedSeller,
        verifiedLineId: normalizedLine,
        disputeId: normalizedDispute,
        evidenceNoteId: args.evidenceNoteId,
        confidence: args.confidence,
        summary: args.summary,
        citedSourceIds: args.citedSourceIds,
        recordedAtMs: state.elapsedMs(),
      };
      state.publishSentinelFinding(finding);
      return { published: true, epoch: finding.epoch, status: finding.status };
    },
  };

  const onEvidenceEvent: SituationHandler = {
    specification: new WhenEvidenceNeedsAudit(),
    processor: {
      apply({ event, participant }) {
        if (!(participant instanceof Agent)) return;

        const targetEpoch = state.epoch;
        const latestNote = state.getLatestWarehouseNote();
        const relevantDispute = state.getLatestRelevantChargeback();
        const s = state.scenario;

        const prompt = [
          "Audit the latest physical warehouse intake notes and any linked PSP dispute webhooks, then call `publish_sentinel_finding` once.",
          `TRIGGER_EVENT: ${event.type}`,
          `CURRENT_EPOCH: ${targetEpoch}`,
          `CHECKOUT_ID: ${s.checkoutId}`,
          "ORDER_LINES:",
          ...s.orderLines.map(
            (l) =>
              `- ${l.lineId} | ${l.sellerId} (${s.sellers[l.sellerId].name}) | SKU ${l.sku} | ${l.itemTitle} | KSh ${l.amountKsh}`,
          ),
          "SETTLEMENTS:",
          ...s.settlements.map(
            (st) =>
              `- ${st.settlementId} | ${st.kind} | KSh ${st.amountKsh} | card ending ${st.cardLast4}`,
          ),
          `WAREHOUSE_NOTE_ID: ${latestNote.noteId}`,
          `WAREHOUSE_HUB: ${latestNote.hub}`,
          "WAREHOUSE_NOTE_TEXT:",
          latestNote.text,
          "CHARGEBACK_SECTION:",
          relevantDispute
            ? [
                `DISPUTE_ID: ${relevantDispute.chargeback.disputeId}`,
                `DISPUTE_STATUS: ${relevantDispute.chargeback.status}`,
                `MATCH_STATE: ${relevantDispute.evaluation.matchState}`,
                `REASON_CODE: ${relevantDispute.chargeback.reasonCode}`,
                `CARD_LAST4: ${relevantDispute.chargeback.cardLast4}`,
                `PSP_REF_SUFFIX: ${relevantDispute.chargeback.pspReferenceSuffix}`,
                `AMOUNT_KSH: ${relevantDispute.chargeback.amountKsh}`,
                `NARRATIVE: ${relevantDispute.chargeback.narrative}`,
              ].join("\n")
            : "NONE",
          "END_EVIDENCE",
          "Call publish_sentinel_finding now with exact checkoutId, epoch, and source IDs (use 'NONE' for inapplicable IDs).",
        ].join("\n");

        state.notifySentinelLoopStarted();
        state.recordEvent(
          "agent.loop_started",
          "DisputeFulfillmentSentinel",
          `Started concurrent evidence audit loop (epoch ${targetEpoch}, note ${latestNote.noteId}${relevantDispute ? `, dispute ${relevantDispute.chargeback.disputeId} [${relevantDispute.evaluation.matchState}]` : ""}).`,
          { epoch: targetEpoch, trigger: event.type },
        );

        // Fresh ModelContext per evidence epoch avoids overlapping tool-call histories
        // if an update arrives while an earlier Sentinel loop is still settling.
        const context =
          event.type === "evidence.updated"
            ? ModelContext.create().addContextItem(
                DeveloperMessageItem.create(SENTINEL_INSTRUCTION),
              )
            : participant.getMemory().getContext();

        runtime.runLoop(participant.getId(), prompt, {
          model: state.modelName,
          context,
          tools: participant.getTools(),
        });
      },
    },
  };

  return createAgent({
    name: "DisputeFulfillmentSentinel",
    capabilities: ["warehouse-inspection", "chargeback-correlation", "evidence-grounding"],
    instruction: SENTINEL_INSTRUCTION,
    tools: [publishFindingTool],
    handlers: [onEvidenceEvent],
  });
}
