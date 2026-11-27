import {
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelMessageItem,
  OpenAIChatCompletions,
  SemanticEvent,
  UserMessageItem,
  supportedModels,
  type InferenceInput,
  type InferenceOutput,
  type InferenceRunner,
  type InferenceRunnerConfig,
} from "@mozaik-ai/core";
import type { SellerId, SentinelEvidenceStatus } from "../finance/types.js";

export const MOCK_MODEL_NAME = "refund-guard-deterministic-v1";

export interface ResolvedInferenceMode {
  readonly mode: "live" | "mock";
  readonly modelName: string;
  readonly inferenceRunnerConfig?: InferenceRunnerConfig;
}

/**
 * Deterministic Mozaik InferenceRunner that parses actual prompt content
 * (customer tickets, warehouse free-text notes, PSP dispute narratives,
 * and interception feedback) so automated tests and live judge edits
 * work reproducibly without requiring an external API key.
 */
export class RefundGuardMockRunner implements InferenceRunner {
  private callCounter = 0;

  constructor(private readonly latencyScale = 1) {}

  async run(input: InferenceInput): Promise<InferenceOutput> {
    const toolNames = new Set((input.tools ?? []).map((t) => t.name));
    const items = input.context.getItems();
    const userMessages = items.filter(
      (item): item is UserMessageItem => item instanceof UserMessageItem,
    );
    const toolOutputs = items.filter(
      (item): item is FunctionCallOutputItem => item instanceof FunctionCallOutputItem,
    );
    const latestUser = userMessages[userMessages.length - 1]?.content.text ?? "";
    const firstUser = userMessages[0]?.content.text ?? "";

    // Branch A: DisputeFulfillmentSentinel agent
    if (toolNames.has("publish_sentinel_finding")) {
      await delay(Math.round(55 * this.latencyScale));

      const lastItem = items[items.length - 1];
      if (lastItem instanceof FunctionCallOutputItem) {
        return {
          items: [
            ModelMessageItem.rehydrate({
              text: `Sentinel verification published to shared RuntimeState: ${lastItem.output.text}`,
            }),
          ],
          tokenUsage: undefined,
          rowResponse: { mock: true, agent: "sentinel" },
        };
      }

      const parsed = analyzeSentinelEvidence(latestUser);
      const callId = `call_sentinel_${++this.callCounter}`;
      return {
        items: [
          FunctionCallItem.rehydrate({
            callId,
            name: "publish_sentinel_finding",
            args: JSON.stringify(parsed),
          }),
        ],
        tokenUsage: undefined,
        rowResponse: { mock: true, agent: "sentinel" },
      };
    }

    // Branch B: Single-Agent Full-Snapshot Baseline (reads t=0 warehouse + dispute + policy)
    if (toolNames.has("propose_refund") && toolNames.has("hold_for_review")) {
      await delay(Math.round(175 * this.latencyScale));

      const lastItem = items[items.length - 1];
      if (lastItem instanceof FunctionCallOutputItem) {
        return {
          items: [
            ModelMessageItem.rehydrate({
              text: `Single-agent snapshot decision recorded: ${lastItem.output.text}`,
            }),
          ],
          tokenUsage: undefined,
          rowResponse: { mock: true, agent: "single-agent-snapshot" },
        };
      }

      const parsedEvidence = analyzeSentinelEvidence(firstUser);
      const checkoutId = extractString(firstUser, /CHECKOUT_ID:\s*([A-Z0-9-]+)/i, "CHK-402");
      const refundAmountKsh = extractInt(firstUser, /REFUND_AMOUNT_KSH:\s*(\d+)/i, 10_000);
      const initialEpoch = extractInt(firstUser, /INITIAL_EPOCH:\s*(\d+)/i, 1);

      if (parsedEvidence.status === "DISPUTE_COLLISION") {
        const callId = `call_snap_${++this.callCounter}`;
        return {
          items: [
            FunctionCallItem.rehydrate({
              callId,
              name: "hold_for_review",
              args: JSON.stringify({
                verdict: "FROZEN_DISPUTE_COLLISION",
                reason: parsedEvidence.summary,
              }),
            }),
          ],
          tokenUsage: undefined,
          rowResponse: { mock: true, agent: "single-agent-snapshot" },
        };
      }

      if (parsedEvidence.status === "DISPUTE_AMBIGUOUS") {
        const callId = `call_snap_${++this.callCounter}`;
        return {
          items: [
            FunctionCallItem.rehydrate({
              callId,
              name: "hold_for_review",
              args: JSON.stringify({
                verdict: "VERIFY_DISPUTE_MATCH",
                reason: parsedEvidence.summary,
              }),
            }),
          ],
          tokenUsage: undefined,
          rowResponse: { mock: true, agent: "single-agent-snapshot" },
        };
      }

      if (parsedEvidence.status === "MISSING_OR_AMBIGUOUS" || parsedEvidence.verifiedSellerId === "NONE") {
        const callId = `call_snap_${++this.callCounter}`;
        return {
          items: [
            FunctionCallItem.rehydrate({
              callId,
              name: "hold_for_review",
              args: JSON.stringify({
                verdict: "HOLD_MISSING_EVIDENCE",
                reason: parsedEvidence.summary,
              }),
            }),
          ],
          tokenUsage: undefined,
          rowResponse: { mock: true, agent: "single-agent-snapshot" },
        };
      }

      const callId = `call_snap_${++this.callCounter}`;
      return {
        items: [
          FunctionCallItem.rehydrate({
            callId,
            name: "propose_refund",
            args: JSON.stringify({
              checkoutId,
              debitSellerId: parsedEvidence.verifiedSellerId,
              refundAmountKsh,
              epoch: initialEpoch,
              rationale: `Single-agent snapshot proposal from t=0 warehouse note: debit ${parsedEvidence.verifiedSellerId}.`,
            }),
          }),
        ],
        tokenUsage: undefined,
        rowResponse: { mock: true, agent: "single-agent-snapshot" },
      };
    }

    // Branch C: RefundDeskAgent (or Ticket-and-Draft baseline)
    if (toolNames.has("propose_refund")) {
      const isReplan = latestUser.includes("INTERCEPTION_FEEDBACK");
      await delay(Math.round((isReplan ? 45 : 175) * this.latencyScale));

      const lastItem = items[items.length - 1];
      if (
        lastItem instanceof FunctionCallOutputItem &&
        !lastItem.output.text.includes("INTERCEPTED_AND_BLOCKED")
      ) {
        return {
          items: [
            ModelMessageItem.rehydrate({
              text: `Refund allocation proposal recorded: ${lastItem.output.text}`,
            }),
          ],
          tokenUsage: undefined,
          rowResponse: { mock: true, agent: "refund-desk" },
        };
      }

      const proposal = analyzeRefundDeskPrompt(firstUser, latestUser, toolOutputs);
      const callId = `call_refund_${++this.callCounter}`;
      return {
        items: [
          FunctionCallItem.rehydrate({
            callId,
            name: "propose_refund",
            args: JSON.stringify(proposal),
          }),
        ],
        tokenUsage: undefined,
        rowResponse: { mock: true, agent: "refund-desk" },
      };
    }

    return {
      items: [
        ModelMessageItem.rehydrate({
          text: `Processed message cleanly (${latestUser.slice(0, 80)})`,
        }),
      ],
      tokenUsage: undefined,
      rowResponse: { mock: true },
    };
  }

  async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
    const out = await this.run(input);
    yield SemanticEvent.create("inference.output", input.model, out);
  }
}

/**
 * Natural-language parser for the Sentinel mock runner.
 * Evaluates actual warehouse note text and linked dispute signals present in
 * the prompt, so live judge edits immediately change findings.
 */
function analyzeSentinelEvidence(prompt: string): {
  epoch: number;
  status: SentinelEvidenceStatus;
  verifiedSellerId: SellerId | "NONE";
  verifiedLineId: string;
  disputeId: string;
  evidenceNoteId: string;
  confidence: "HIGH" | "LOW";
  summary: string;
  citedSourceIds: string[];
} {
  const epoch = extractInt(prompt, /CURRENT_EPOCH:\s*(\d+)/i, 1);
  const noteId = extractString(prompt, /WAREHOUSE_NOTE_ID:\s*([A-Z0-9-]+)/i, "WH-UNKNOWN");
  const noteText = extractSection(prompt, "WAREHOUSE_NOTE_TEXT:", "CHARGEBACK_SECTION:");
  const chargebackSection = extractSection(prompt, "CHARGEBACK_SECTION:", "END_EVIDENCE");

  // 1. Evaluate dispute linkage if present in CHARGEBACK_SECTION
  if (chargebackSection.length > 0 && !/^NONE$/i.test(chargebackSection.trim())) {
    const disputeId = extractString(
      chargebackSection,
      /DISPUTE_ID:\s*([A-Z0-9-]+)/i,
      "DSP-LIVE",
    );
    const matchState = extractString(
      chargebackSection,
      /MATCH_STATE:\s*([A-Z_]+)/i,
      "VERIFIED_ACTIVE_MATCH",
    );
    const disputeStatus = extractString(
      chargebackSection,
      /DISPUTE_STATUS:\s*([A-Z_]+)/i,
      "OPEN",
    );

    if (disputeStatus === "OPEN" && matchState === "VERIFIED_ACTIVE_MATCH") {
      return {
        epoch,
        status: "DISPUTE_COLLISION",
        verifiedSellerId: inferWarehouseSeller(noteText) ?? "NONE",
        verifiedLineId:
          inferWarehouseSeller(noteText) === "SELLER-A"
            ? "LINE-402-A"
            : inferWarehouseSeller(noteText) === "SELLER-B"
              ? "LINE-402-B"
              : "NONE",
        disputeId,
        evidenceNoteId: noteId,
        confidence: "HIGH",
        summary: `Verified active PSP dispute ${disputeId} linked to checkout CHK-402 / STL-PAY-402. Block unsafe cross-system refund proposal.`,
        citedSourceIds: [disputeId, noteId, "STL-PAY-402"],
      };
    }

    if (disputeStatus === "OPEN" && matchState === "AMBIGUOUS_MATCH") {
      return {
        epoch,
        status: "DISPUTE_AMBIGUOUS",
        verifiedSellerId: "NONE",
        verifiedLineId: "NONE",
        disputeId,
        evidenceNoteId: noteId,
        confidence: "LOW",
        summary: `Dispute ${disputeId} partially matches payment signals for CHK-402; operator verification required before releasing payout.`,
        citedSourceIds: [disputeId, noteId, "STL-PAY-402"],
      };
    }
  }

  // 2. Check for missing / unreceived / unverified parcel language
  const lowerNote = noteText.toLowerCase();
  const isMissing =
    /(no parcel|not received|label created only|unverified|missing|empty box|ambiguous|unknown item|pending delivery)/i.test(
      lowerNote,
    );
  if (isMissing) {
    return {
      epoch,
      status: "MISSING_OR_AMBIGUOUS",
      verifiedSellerId: "NONE",
      verifiedLineId: "NONE",
      disputeId: "NONE",
      evidenceNoteId: noteId,
      confidence: "LOW",
      summary: `Warehouse intake ${noteId} does not confirm physical receipt of an identifiable seller SKU.`,
      citedSourceIds: [noteId],
    };
  }

  // 3. Determine which seller's item physically came back from free-text note.
  const seller = inferWarehouseSeller(noteText);
  if (seller === "SELLER-A") {
    return {
      epoch,
      status: "VERIFIED_RETURN",
      verifiedSellerId: "SELLER-A",
      verifiedLineId: "LINE-402-A",
      disputeId: "NONE",
      evidenceNoteId: noteId,
      confidence: "HIGH",
      summary: `Verified physical return of Navy Quilted Winter Jacket (LINE-402-A / SELLER-A) from ${noteId}.`,
      citedSourceIds: [noteId, "LINE-402-A"],
    };
  }

  if (seller === "SELLER-B") {
    return {
      epoch,
      status: "VERIFIED_RETURN",
      verifiedSellerId: "SELLER-B",
      verifiedLineId: "LINE-402-B",
      disputeId: "NONE",
      evidenceNoteId: noteId,
      confidence: "HIGH",
      summary: `Verified physical return of Tan Leather Chelsea Boots (LINE-402-B / SELLER-B) from ${noteId}.`,
      citedSourceIds: [noteId, "LINE-402-B"],
    };
  }

  return {
    epoch,
    status: "MISSING_OR_AMBIGUOUS",
    verifiedSellerId: "NONE",
    verifiedLineId: "NONE",
    disputeId: "NONE",
    evidenceNoteId: noteId,
    confidence: "LOW",
    summary: `Warehouse note ${noteId} is ambiguous between Seller A and Seller B; holding for human inspection.`,
    citedSourceIds: [noteId],
  };
}

function inferWarehouseSeller(noteText: string): SellerId | null {
  const lowerNote = noteText.toLowerCase();
  const negatedBoots =
    /(no boots|boots were not|boots not returned|reused the boot box|inside is actually[^.!;\n]*jacket)/i.test(
      lowerNote,
    );
  const negatedJacket =
    /(no jacket|jacket was not|jacket not returned|reused the jacket|inside is actually[^.!;\n]*boots)/i.test(
      lowerNote,
    );

  const mentionsJacket =
    !negatedJacket &&
    /(jacket|jkt-nvy-l|nairobi streetwear|seller a|seller-a|line-402-a)/i.test(lowerNote);
  const mentionsBoots =
    !negatedBoots &&
    /(boots|chelsea|footwear|bts-tan-42|rift valley|seller b|seller-b|line-402-b)/i.test(
      lowerNote,
    );

  if (mentionsJacket && !mentionsBoots) return "SELLER-A";
  if (mentionsBoots && !mentionsJacket) return "SELLER-B";
  return null;
}

function analyzeRefundDeskPrompt(
  firstUser: string,
  latestUser: string,
  _toolOutputs: readonly FunctionCallOutputItem[],
): {
  checkoutId: string;
  debitSellerId: SellerId;
  refundAmountKsh: number;
  epoch: number;
  rationale: string;
} {
  const checkoutId = extractString(firstUser, /CHECKOUT_ID:\s*([A-Z0-9-]+)/i, "CHK-402");
  const refundAmountKsh = extractInt(firstUser, /REFUND_AMOUNT_KSH:\s*(\d+)/i, 10_000);
  const initialEpoch = extractInt(firstUser, /INITIAL_EPOCH:\s*(\d+)/i, 1);

  if (latestUser.includes("INTERCEPTION_FEEDBACK")) {
    const correctedSeller = extractString(
      latestUser,
      /debitSellerId="(SELLER-[AB])"/i,
      "SELLER-A",
    ) as SellerId;
    const correctedEpoch = extractInt(latestUser, /epoch=(\d+)/i, initialEpoch);
    return {
      checkoutId,
      debitSellerId: correctedSeller,
      refundAmountKsh,
      epoch: correctedEpoch,
      rationale: `Re-planned after Mozaik interception using Sentinel-verified seller ${correctedSeller} on epoch ${correctedEpoch}.`,
    };
  }

  const ticketText = extractSection(firstUser, "CUSTOMER_TICKET:", "PAYOUT_DRAFT:");
  const draftDebitedSeller = extractString(
    firstUser,
    /DRAFT_DEBITED_SELLER:\s*(SELLER-[AB])/i,
    "SELLER-B",
  ) as SellerId;

  let chosenSeller: SellerId = draftDebitedSeller;
  const lowerTicket = ticketText.toLowerCase();
  if (/(jacket|jkt-nvy-l|nairobi streetwear)/i.test(lowerTicket)) {
    chosenSeller = "SELLER-A";
  } else if (/(boots|chelsea|bts-tan-42|rift valley)/i.test(lowerTicket)) {
    chosenSeller = "SELLER-B";
  }

  return {
    checkoutId,
    debitSellerId: chosenSeller,
    refundAmountKsh,
    epoch: initialEpoch,
    rationale: `Initial refund desk proposal based on ticket and draft queue: debit ${chosenSeller} KSh ${refundAmountKsh.toLocaleString("en-KE")} (epoch ${initialEpoch}).`,
  };
}

const ALL_CONTEXT_ITEM_TYPES = [
  "user_message",
  "system_message",
  "developer_message",
  "reasoning",
  "function_call",
  "function_call_output",
  "model_message",
];

export function resolveInferenceMode(options?: {
  modeOverride?: "auto" | "live" | "mock";
  latencyScale?: number;
}): ResolvedInferenceMode {
  const requested =
    options?.modeOverride ??
    (process.env.REFUND_GUARD_MODE as "auto" | "live" | "mock" | undefined) ??
    "auto";

  const envModel = process.env.REFUND_GUARD_MODEL?.trim();
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const hasGemini = Boolean(process.env.GEMINI_API_KEY?.trim());
  const hasAnyKey = hasOpenAI || hasAnthropic || hasGemini;

  const useLive = requested === "live" || (requested === "auto" && hasAnyKey);

  if (useLive) {
    let modelName = envModel;
    if (!modelName) {
      if (hasOpenAI) modelName = "gpt-5.4-mini";
      else if (hasAnthropic) modelName = "claude-haiku-4-5";
      else if (hasGemini) modelName = "gemini-3.5-flash";
      else modelName = "gpt-5.4-mini";
    }

    const isKnown = supportedModels.some((m) => m.specification.name === modelName);
    if (!isKnown) {
      return {
        mode: "live",
        modelName,
        inferenceRunnerConfig: {
          supportedModels: [
            ...supportedModels,
            {
              endpoint: new OpenAIChatCompletions(),
              specification: {
                name: modelName,
                provider: "openai",
                supportsReasoningEffort: false,
                supportedReasoningEfforts: [],
                supportsStreaming: true,
                contextWindowSize: 128_000,
                supportedContextItemTypes: ALL_CONTEXT_ITEM_TYPES,
                maxOutputTokens: 16_384,
                supportsFunctionCalling: true,
                supportsStructuredOutput: true,
              },
            },
          ],
        },
      };
    }

    return {
      mode: "live",
      modelName,
    };
  }

  return {
    mode: "mock",
    modelName: MOCK_MODEL_NAME,
    inferenceRunnerConfig: {
      supportedModels: [
        {
          endpoint: new OpenAIChatCompletions(),
          specification: {
            name: MOCK_MODEL_NAME,
            provider: "openai",
            supportsReasoningEffort: false,
            supportedReasoningEfforts: [],
            supportsStreaming: false,
            contextWindowSize: 100_000,
            supportedContextItemTypes: ALL_CONTEXT_ITEM_TYPES,
            maxOutputTokens: 16_384,
            supportsFunctionCalling: true,
            supportsStructuredOutput: false,
          },
        },
      ],
      runner: new RefundGuardMockRunner(options?.latencyScale ?? 1),
    },
  };
}

function extractString(text: string, regex: RegExp, fallback: string): string {
  const match = text.match(regex);
  return match?.[1]?.trim() ?? fallback;
}

function extractInt(text: string, regex: RegExp, fallback: number): number {
  const match = text.match(regex);
  if (!match?.[1]) return fallback;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : fallback;
}

function extractSection(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";
  const afterStart = start + startMarker.length;
  const end = text.indexOf(endMarker, afterStart);
  return (end === -1 ? text.slice(afterStart) : text.slice(afterStart, end)).trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
