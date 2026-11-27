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

interface ParsedOrderLine {
  lineId: string;
  sellerId: SellerId;
  sellerName: string;
  sku: string;
  itemTitle: string;
  keywords: string[];
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

/**
 * Deterministic Mozaik InferenceRunner that parses actual prompt content
 * (order lines, customer tickets, warehouse free-text notes, PSP dispute
 * narratives, and interception feedback) so automated tests, multi-checkout
 * batches, and live judge edits work reproducibly without an API key.
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

function parseOrderLinesFromPrompt(prompt: string): ParsedOrderLine[] {
  const lines: ParsedOrderLine[] = [];
  const regex =
    /^-\s+([A-Z0-9-]+)\s+\|\s+(SELLER-[AB])\s+\(([^)]+)\)\s+\|\s+(?:SKU\s+)?([A-Z0-9-]+)\s+\|\s+([^|]+)\|/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt)) !== null) {
    const lineId = match[1].trim();
    const sellerId = match[2].trim() as SellerId;
    const sellerName = match[3].trim();
    const sku = match[4].trim();
    const itemTitle = match[5].trim();

    const stopWords = new Set([
      "size",
      "with",
      "from",
      "pack",
      "set",
      "and",
      "the",
      "for",
      "ltd",
      "co",
    ]);
    const rawTokens = `${sellerName} ${sku} ${itemTitle}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !stopWords.has(w));

    lines.push({
      lineId,
      sellerId,
      sellerName,
      sku,
      itemTitle,
      keywords: Array.from(new Set(rawTokens)),
    });
  }
  return lines;
}

/**
 * Rule-based deterministic parser for the Sentinel mock runner.
 * Evaluates order lines, warehouse note text, and linked dispute signals present
 * in the prompt (limited natural-language coverage; configure an LLM API key for
 * open-ended free-text parsing).
 */
function analyzeSentinelEvidence(prompt: string): {
  epoch: number;
  checkoutId: string;
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
  const checkoutId = extractString(prompt, /CHECKOUT_ID:\s*([A-Z0-9-]+)/i, "CHK-402");
  const settlementId = extractString(prompt, /-\s+(STL-PAY-[A-Z0-9-]+)/i, "STL-PAY-402");
  const noteId = extractString(prompt, /WAREHOUSE_NOTE_ID:\s*([A-Z0-9-]+)/i, "WH-UNKNOWN");
  const noteText = extractSection(prompt, "WAREHOUSE_NOTE_TEXT:", "CHARGEBACK_SECTION:");
  const chargebackSection = extractSection(prompt, "CHARGEBACK_SECTION:", "END_EVIDENCE");
  const orderLines = parseOrderLinesFromPrompt(prompt);

  const missingOrTentative = isWarehouseNoteMissingOrTentative(noteText);
  const matchedLine = missingOrTentative ? null : inferWarehouseOrderLine(noteText, orderLines);

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

    if (
      (disputeStatus === "OPEN" && matchState === "VERIFIED_ACTIVE_MATCH") ||
      (disputeStatus === "CLOSED_LOST" && matchState === "VERIFIED_LOST_DISPUTE")
    ) {
      return {
        epoch,
        checkoutId,
        status: "DISPUTE_COLLISION",
        verifiedSellerId: matchedLine?.sellerId ?? "NONE",
        verifiedLineId: matchedLine?.lineId ?? "NONE",
        disputeId,
        evidenceNoteId: noteId,
        confidence: matchedLine ? "HIGH" : "LOW",
        summary:
          matchState === "VERIFIED_LOST_DISPUTE"
            ? `Verified prior lost PSP dispute ${disputeId} (CLOSED_LOST) linked to ${checkoutId} / ${settlementId}. Block additional refund.`
            : `Verified active PSP dispute ${disputeId} linked to ${checkoutId} / ${settlementId}. Block unsafe cross-system refund proposal.`,
        citedSourceIds: [disputeId, noteId, settlementId],
      };
    }

    if (matchState === "AMBIGUOUS_MATCH") {
      return {
        epoch,
        checkoutId,
        status: "DISPUTE_AMBIGUOUS",
        verifiedSellerId: "NONE",
        verifiedLineId: "NONE",
        disputeId,
        evidenceNoteId: noteId,
        confidence: "LOW",
        summary: `Dispute ${disputeId} partially matches or conflicts with payment signals for ${checkoutId}; operator verification required before releasing payout.`,
        citedSourceIds: [disputeId, noteId, settlementId],
      };
    }
  }

  // 2. Check for missing / unreceived / tentative / multi-item ambiguous language
  if (missingOrTentative) {
    return {
      epoch,
      checkoutId,
      status: "MISSING_OR_AMBIGUOUS",
      verifiedSellerId: "NONE",
      verifiedLineId: "NONE",
      disputeId: "NONE",
      evidenceNoteId: noteId,
      confidence: "LOW",
      summary: `Warehouse intake ${noteId} is missing, tentative, or ambiguous and does not verify a single returned seller SKU.`,
      citedSourceIds: [noteId],
    };
  }

  // 3. Return verified seller line match ONLY when affirmative physical receipt/inspection is present
  if (matchedLine && hasAffirmativePhysicalReceipt(noteText)) {
    return {
      epoch,
      checkoutId,
      status: "VERIFIED_RETURN",
      verifiedSellerId: matchedLine.sellerId,
      verifiedLineId: matchedLine.lineId,
      disputeId: "NONE",
      evidenceNoteId: noteId,
      confidence: "HIGH",
      summary: `Verified physical return of ${matchedLine.itemTitle} (${matchedLine.lineId} / ${matchedLine.sellerId}) from ${noteId}.`,
      citedSourceIds: [noteId, matchedLine.lineId],
    };
  }

  return {
    epoch,
    checkoutId,
    status: "MISSING_OR_AMBIGUOUS",
    verifiedSellerId: "NONE",
    verifiedLineId: "NONE",
    disputeId: "NONE",
    evidenceNoteId: noteId,
    confidence: "LOW",
    summary: `Warehouse note ${noteId} lacks affirmative physical receipt proof or is ambiguous between sellers; holding for human inspection.`,
    citedSourceIds: [noteId],
  };
}

function isWarehouseNoteMissingOrTentative(noteText: string): boolean {
  const normalized = noteText
    .toLowerCase()
    .replace(/\b(nothing|none|no\s+items?)\s+missing\b/g, "complete");

  if (
    /\b(no parcel|label created only|label only|barcode only|carton barcode only|manifest only|contents never checked|never checked|not checked|unverified|empty box|ambiguous|unknown item|pending delivery|pending bench|pending inspection|pending qc|tentative|preliminary|unopened|not yet opened|not yet inspected|remains sealed|still sealed|sealed carton|sealed box|external sticker|exterior sticker|sticker reads|will send back|will return|plans to return|promised to return|to be returned|next week|both items|both products|all items|still in transit|in transit|expected tomorrow|expected to arrive|could not locate|cannot locate|hub has not seen|has not seen|not the ordered item|wrong brand|wrong item|customer claims)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }

  if (/\bmissing\b/i.test(normalized)) {
    return true;
  }

  return false;
}

function hasAffirmativePhysicalReceipt(noteText: string): boolean {
  const positiveClauses = noteText
    .toLowerCase()
    .split(/[.;!\n]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .filter(
      (c) =>
        !/\b(did not receive|didn't receive|never received|not received|wasn't in the box|was not in the box|not in the box|was not|were not|not returned|not in parcel|no boots|no jacket|kept by|customer kept|buyer kept|kept the|reused the .* box|will send|will return|plans to|expected to)\b/i.test(
          c,
        ),
    );
  const positiveText = positiveClauses.join(" | ");
  return /\b(received|checked in|confirmed|verified|opened|bench|logged|inside is|came back|intake|physically)\b/i.test(
    positiveText,
  );
}

function inferWarehouseOrderLine(
  noteText: string,
  orderLines: readonly ParsedOrderLine[],
): ParsedOrderLine | null {
  const lowerNote = noteText.toLowerCase();

  // Split into clauses so negations ("did not receive jacket", "jacket wasn't in the box",
  // "boots were NOT returned", "customer kept the jacket") suppress only the negated clause.
  const positiveClauses = lowerNote
    .split(/[.;!\n]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .filter(
      (c) =>
        !/\b(did not receive|didn't receive|never received|not received|wasn't in the box|was not in the box|not in the box|was not|were not|not returned|not in parcel|no boots|no jacket|kept by|customer kept|buyer kept|kept the|reused the .* box)\b/i.test(
          c,
        ),
    );
  const positiveText = positiveClauses.join(" | ");
  if (positiveText.length === 0) {
    return null;
  }

  const actualMatch = positiveText.match(/inside is actually([^|]+)/i);

  // Dynamic scoring against parsed ORDER_LINES from the prompt
  if (orderLines.length > 0) {
    const scored = orderLines.map((line) => {
      let score = 0;
      if (positiveText.includes(line.lineId.toLowerCase())) score += 10;
      if (positiveText.includes(line.sku.toLowerCase())) score += 10;
      if (positiveText.includes(line.sellerId.toLowerCase())) score += 6;
      if (positiveText.includes(line.sellerName.toLowerCase())) score += 6;
      if (
        line.sellerId === "SELLER-A" &&
        /\bseller\s+a\b/i.test(positiveText)
      ) {
        score += 6;
      }
      if (
        line.sellerId === "SELLER-B" &&
        /\bseller\s+b\b/i.test(positiveText)
      ) {
        score += 6;
      }
      for (const kw of line.keywords) {
        if (positiveText.includes(kw)) {
          score += 2;
        }
      }
      // If a correction clause explicitly says "inside is actually ...", prioritize it heavily.
      if (actualMatch) {
        const actualClause = actualMatch[1];
        if (
          actualClause.includes(line.sku.toLowerCase()) ||
          line.keywords.some((kw) => actualClause.includes(kw))
        ) {
          score += 12;
        }
      }
      return { line, score };
    });

    scored.sort((a, b) => b.score - a.score);
    // If two different sellers both have positive return mentions and there is no explicit
    // "inside is actually ..." override, fail closed as ambiguous rather than guessing.
    if (
      !actualMatch &&
      scored.length >= 2 &&
      scored[0].score > 0 &&
      scored[1].score > 0 &&
      scored[0].line.sellerId !== scored[1].line.sellerId
    ) {
      return null;
    }
    if (scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) {
      return scored[0].line;
    }
    return null;
  }

  // Fallback for prompts without ORDER_LINES section
  const mentionsJacket =
    /(jacket|jkt-nvy-l|nairobi streetwear|seller a|seller-a|line-402-a)/i.test(positiveText);
  const mentionsBoots =
    /(boots|chelsea|footwear|bts-tan-42|rift valley|seller b|seller-b|line-402-b)/i.test(
      positiveText,
    );

  if (mentionsJacket && !mentionsBoots) {
    return {
      lineId: "LINE-402-A",
      sellerId: "SELLER-A",
      sellerName: "Nairobi Streetwear Co.",
      sku: "JKT-NVY-L",
      itemTitle: "Navy Quilted Winter Jacket (Size L)",
      keywords: ["jacket"],
    };
  }
  if (mentionsBoots && !mentionsJacket) {
    return {
      lineId: "LINE-402-B",
      sellerId: "SELLER-B",
      sellerName: "Rift Valley Footwear",
      sku: "BTS-TAN-42",
      itemTitle: "Tan Leather Chelsea Boots (Size 42)",
      keywords: ["boots"],
    };
  }
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
  const orderLines = parseOrderLinesFromPrompt(firstUser);
  const ticketMatchedLine = inferWarehouseOrderLine(ticketText, orderLines);
  const chosenSeller: SellerId = ticketMatchedLine?.sellerId ?? draftDebitedSeller;

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
