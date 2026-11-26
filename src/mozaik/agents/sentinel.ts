import {
  Agent,
  createAgent,
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

export function createSentinelAgent(
  runtime: RefundGuardRuntimeApi,
  state: RefundGuardState,
): Agent {
  const publishFindingTool: Tool = {
    type: "function",
    name: "publish_sentinel_finding",
    description:
      "Publish verified warehouse return attribution or PSP chargeback collision findings to shared RuntimeState for the specified epoch.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        epoch: { type: "number" },
        status: {
          type: "string",
          enum: ["VERIFIED_RETURN", "MISSING_OR_AMBIGUOUS", "DISPUTE_COLLISION"],
        },
        verifiedSellerId: { type: ["string", "null"], enum: ["SELLER-A", "SELLER-B", null] },
        verifiedLineId: { type: ["string", "null"] },
        disputeId: { type: ["string", "null"] },
        evidenceNoteId: { type: "string" },
        confidence: { type: "string", enum: ["HIGH", "LOW"] },
        summary: { type: "string" },
        citedSourceIds: { type: "array", items: { type: "string" } },
      },
      required: [
        "epoch",
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
      status: SentinelEvidenceStatus;
      verifiedSellerId: SellerId | null;
      verifiedLineId: string | null;
      disputeId: string | null;
      evidenceNoteId: string;
      confidence: "HIGH" | "LOW";
      summary: string;
      citedSourceIds: string[];
    }) => {
      const finding = {
        epoch: args.epoch,
        status: args.status,
        verifiedSellerId: args.verifiedSellerId,
        verifiedLineId: args.verifiedLineId,
        disputeId: args.disputeId,
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
        const latestChargeback = state.getLatestChargeback();
        const s = state.scenario;

        const prompt = [
          "Audit the latest physical warehouse intake notes and any asynchronous PSP chargeback webhooks, then call `publish_sentinel_finding`.",
          `TRIGGER_EVENT: ${event.type}`,
          `CURRENT_EPOCH: ${targetEpoch}`,
          `CHECKOUT_ID: ${s.checkoutId}`,
          "ORDER_LINES:",
          ...s.orderLines.map(
            (l) => `- ${l.lineId} | ${l.sellerId} (${s.sellers[l.sellerId].name}) | SKU ${l.sku} | ${l.itemTitle} | KSh ${l.amountKsh}`,
          ),
          "SETTLEMENTS:",
          ...s.settlements.map(
            (st) => `- ${st.settlementId} | ${st.kind} | KSh ${st.amountKsh} | card ending ${st.cardLast4}`,
          ),
          `WAREHOUSE_NOTE_ID: ${latestNote.noteId}`,
          `WAREHOUSE_HUB: ${latestNote.hub}`,
          "WAREHOUSE_NOTE_TEXT:",
          latestNote.text,
          "CHARGEBACK_SECTION:",
          latestChargeback
            ? [
                `DISPUTE_ID: ${latestChargeback.disputeId}`,
                `REASON_CODE: ${latestChargeback.reasonCode}`,
                `CARD_LAST4: ${latestChargeback.cardLast4}`,
                `PSP_REF_SUFFIX: ${latestChargeback.pspReferenceSuffix}`,
                `AMOUNT_KSH: ${latestChargeback.amountKsh}`,
                `NARRATIVE: ${latestChargeback.narrative}`,
              ].join("\n")
            : "NONE",
          "END_EVIDENCE",
          "Call publish_sentinel_finding now with exact source IDs.",
        ].join("\n");

        state.sentinelPendingCount += 1;
        state.sentinelWindows.push({ startedAtMs: Date.now() });
        state.recordEvent(
          "agent.loop_started",
          "DisputeFulfillmentSentinel",
          `Started concurrent evidence audit loop (epoch ${targetEpoch}, note ${latestNote.noteId}${latestChargeback ? `, dispute ${latestChargeback.disputeId}` : ""}).`,
          { epoch: targetEpoch, trigger: event.type },
        );

        runtime.runLoop(participant.getId(), prompt, {
          model: state.modelName,
          context: participant.getMemory().getContext(),
          tools: participant.getTools(),
        });
      },
    },
  };

  return createAgent({
    name: "DisputeFulfillmentSentinel",
    capabilities: ["warehouse-inspection", "chargeback-correlation", "evidence-grounding"],
    instruction:
      "You are the Dispute & Fulfillment Sentinel Agent running concurrently with the Refund Desk Agent. Parse unstructured warehouse return notes and asynchronous issuing-bank chargeback narratives. First check if any bank chargeback collides with the checkout (even if external IDs differ, match by card last-4, checkout suffix, amount, and item description); if so, publish status=DISPUTE_COLLISION. Otherwise, determine which exact seller line item physically arrived back at the warehouse; if no parcel arrived or contents are unverified/ambiguous, publish status=MISSING_OR_AMBIGUOUS. Always call `publish_sentinel_finding` with the exact CURRENT_EPOCH and source IDs.",
    tools: [publishFindingTool],
    handlers: [onEvidenceEvent],
  });
}
