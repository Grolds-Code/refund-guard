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
 * and interception feedback) so both automated tests and live judge edits
 * work reliably with zero external API keys.
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

    // Branch A: DisputeFulfillmentSentinel agent (has `publish_sentinel_finding` tool)
    if (toolNames.has("publish_sentinel_finding")) {
      await delay(Math.round(55 * this.latencyScale));

      // If tool already executed for the latest user turn, emit concise summary.
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

    // Branch B: RefundDeskAgent (or Baseline single agent) with `propose_refund` tool
    if (toolNames.has("propose_refund")) {
      // Simulate realistic LLM reasoning window so mid-flight events genuinely overlap.
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
 * Evaluates the actual warehouse note text and chargeback webhook narrative
 * present in the prompt, so live judge edits immediately change findings.
 */
function analyzeSentinelEvidence(prompt: string): {
  epoch: number;
  status: SentinelEvidenceStatus;
  verifiedSellerId: SellerId | null;
  verifiedLineId: string | null;
  disputeId: string | null;
  evidenceNoteId: string;
  confidence: "HIGH" | "LOW";
  summary: string;
  citedSourceIds: string[];
} {
  const epoch = extractInt(prompt, /CURRENT_EPOCH:\s*(\d+)/i, 1);
  const noteId = extractString(prompt, /WAREHOUSE_NOTE_ID:\s*([A-Z0-9-]+)/i, "WH-UNKNOWN");
  const noteText = extractSection(prompt, "WAREHOUSE_NOTE_TEXT:", "CHARGEBACK_SECTION:");
  const chargebackSection = extractSection(prompt, "CHARGEBACK_SECTION:", "END_EVIDENCE");

  // 1. Check for active bank chargeback / dispute collision
  const hasChargeback =
    chargebackSection.length > 0 &&
    !/NONE/i.test(chargebackSection.trim()) &&
    /(chargeback|dispute|visa|mastercard|13\.1|dsp-)/i.test(chargebackSection);

  if (hasChargeback) {
    const disputeId = extractString(
      chargebackSection,
      /DISPUTE_ID:\s*([A-Z0-9-]+)/i,
      "DSP-LIVE",
    );
    return {
      epoch,
      status: "DISPUTE_COLLISION",
      verifiedSellerId: null,
      verifiedLineId: null,
      disputeId,
      evidenceNoteId: noteId,
      confidence: "HIGH",
      summary: `Correlated asynchronous PSP chargeback ${disputeId} against checkout CHK-402 (card ending 4421, KSh 10,000). Store refund must be frozen to prevent double-payout.`,
      citedSourceIds: [disputeId, noteId, "STL-PAY-402"],
    };
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
      verifiedSellerId: null,
      verifiedLineId: null,
      disputeId: null,
      evidenceNoteId: noteId,
      confidence: "LOW",
      summary: `Warehouse intake ${noteId} does not confirm physical receipt of an identifiable seller SKU.`,
      citedSourceIds: [noteId],
    };
  }

  // 3. Determine which seller's item physically came back from free-text note.
  // Handle negation carefully (e.g., "No boots in parcel" or "boots were NOT returned").
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

  if (mentionsJacket && !mentionsBoots) {
    return {
      epoch,
      status: "VERIFIED_RETURN",
      verifiedSellerId: "SELLER-A",
      verifiedLineId: "LINE-402-A",
      disputeId: null,
      evidenceNoteId: noteId,
      confidence: "HIGH",
      summary: `Verified physical return of Navy Quilted Winter Jacket (LINE-402-A / SELLER-A) from ${noteId}.`,
      citedSourceIds: [noteId, "LINE-402-A"],
    };
  }

  if (mentionsBoots && !mentionsJacket) {
    return {
      epoch,
      status: "VERIFIED_RETURN",
      verifiedSellerId: "SELLER-B",
      verifiedLineId: "LINE-402-B",
      disputeId: null,
      evidenceNoteId: noteId,
      confidence: "HIGH",
      summary: `Verified physical return of Tan Leather Chelsea Boots (LINE-402-B / SELLER-B) from ${noteId}.`,
      citedSourceIds: [noteId, "LINE-402-B"],
    };
  }

  return {
    epoch,
    status: "MISSING_OR_AMBIGUOUS",
    verifiedSellerId: null,
    verifiedLineId: null,
    disputeId: null,
    evidenceNoteId: noteId,
    confidence: "LOW",
    summary: `Warehouse note ${noteId} is ambiguous between Seller A and Seller B; holding for human inspection.`,
    citedSourceIds: [noteId],
  };
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

  // If this turn is a replan triggered by RefundInterceptionGate, follow the verified correction!
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

  // Initial pass: Refund Desk reads the customer ticket + payout draft queue.
  // If the ticket explicitly names the jacket or boots, use that; otherwise follow the draft's debited seller.
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
      // Allow any custom OpenAI-compatible model name via OpenAIChatCompletions
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
                supportedContextItemTypes: ["message", "function_call", "function_call_output"],
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
            supportedContextItemTypes: ["message", "function_call", "function_call_output"],
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
