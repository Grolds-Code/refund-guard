import {
  createHuman,
  SituationSpecification,
  type Human,
  type SituationContext,
  type SituationHandler,
} from "@mozaik-ai/core";
import type { RefundGuardState } from "../runtime.js";

class WhenModelAnswersOrInterceptionRuns extends SituationSpecification {
  isSatisfiedBy({ event }: SituationContext): boolean {
    return (
      event.type === "message_received.started" ||
      event.type === "model.answer" ||
      event.type === "interception.started" ||
      event.type === "interception.finished"
    );
  }
}

function parsePromptEpoch(content: unknown, fallbackEpoch: number): {
  epoch: number;
  isReplan: boolean;
} {
  if (typeof content !== "string") return { epoch: fallbackEpoch, isReplan: false };
  if (content.includes("INTERCEPTION_FEEDBACK")) {
    const m = content.match(/\bepoch=(\d+)/i);
    if (m?.[1]) {
      const parsed = Number.parseInt(m[1], 10);
      if (Number.isFinite(parsed) && parsed >= 1) {
        return { epoch: parsed, isReplan: true };
      }
    }
  }
  const match = content.match(/(?:CURRENT_EPOCH|INITIAL_EPOCH):\s*(\d+)/i);
  if (!match?.[1]) return { epoch: fallbackEpoch, isReplan: false };
  const parsed = Number.parseInt(match[1], 10);
  return {
    epoch: Number.isFinite(parsed) && parsed >= 1 ? parsed : fallbackEpoch,
    isReplan: false,
  };
}

/**
 * Non-blocking Mozaik observer participant that binds each concurrent agent loop
 * by its exact Mozaik `loopId` (not FIFO order), tracks accurate completion windows
 * even when overlapping loops finish out of order, and tags only genuinely
 * superseded loop completions as stale.
 */
export function createAuditObserver(
  state: RefundGuardState,
  refundDeskId: string,
  sentinelId: string,
): Human {
  const handler: SituationHandler = {
    specification: new WhenModelAnswersOrInterceptionRuns(),
    processor: {
      apply({ event }) {
        if (event.type === "message_received.started") {
          const payload = event.payload as
            | { loopId?: string; content?: string }
            | undefined;
          const loopId = payload?.loopId;
          if (!loopId) return;
          const { epoch: promptEpoch, isReplan } = parsePromptEpoch(
            payload?.content,
            state.epoch,
          );
          if (event.producerId === refundDeskId) {
            state.bindLoopWindow("refund", loopId, promptEpoch, isReplan);
          } else if (event.producerId === sentinelId) {
            state.bindLoopWindow("sentinel", loopId, promptEpoch, isReplan);
          }
          return;
        }

        if (event.type === "interception.started") {
          state.recordEvent(
            "mozaik.interception_started",
            "MozaikRuntime",
            "Mozaik runtime paused RefundDeskAgent transition for awaited InterceptionHandler.",
          );
          return;
        }

        if (event.type === "interception.finished") {
          state.recordEvent(
            "mozaik.interception_finished",
            "MozaikRuntime",
            "Mozaik runtime resumed with transition returned by InterceptionHandler.",
          );
          return;
        }

        if (event.type === "model.answer") {
          const payload = event.payload as
            | { loopId?: string; answer?: { content?: { text?: string } } }
            | undefined;
          const loopId = payload?.loopId;
          const text = payload?.answer?.content?.text ?? "";

          if (event.producerId === refundDeskId) {
            const matchedWindow = state.resolveLoopWindow("refund", loopId);
            if (matchedWindow) {
              matchedWindow.endedAtMs = Date.now();
            }
            const loopEpoch = matchedWindow?.epoch ?? state.epoch;
            const isStale = loopEpoch < state.epoch;
            const prefix = isStale
              ? `[STALE epoch ${loopEpoch} superseded by epoch ${state.epoch}] `
              : "";
            state.recordEvent(
              isStale ? "agent.completed_stale" : "agent.completed",
              "RefundDeskAgent",
              `${prefix}${text.slice(0, 220) || "RefundDeskAgent loop completed."}`,
              {
                loopId,
                loopEpoch,
                ...(isStale ? { staleLoopEpoch: loopEpoch, currentEpoch: state.epoch } : {}),
              },
            );
            state.notifyRefundDeskLoopSettled();
          } else if (event.producerId === sentinelId) {
            const matchedWindow = state.resolveLoopWindow("sentinel", loopId);
            if (matchedWindow) {
              matchedWindow.endedAtMs = Date.now();
            }
            const loopEpoch = matchedWindow?.epoch ?? state.epoch;
            const isStale = loopEpoch < state.epoch;
            const prefix = isStale
              ? `[STALE epoch ${loopEpoch} superseded by epoch ${state.epoch}] `
              : "";
            state.recordEvent(
              isStale ? "agent.completed_stale" : "agent.completed",
              "DisputeFulfillmentSentinel",
              `${prefix}${text.slice(0, 220) || "DisputeFulfillmentSentinel loop completed."}`,
              {
                loopId,
                loopEpoch,
                ...(isStale ? { staleLoopEpoch: loopEpoch, currentEpoch: state.epoch } : {}),
              },
            );
            state.notifySentinelLoopSettled();
          }
        }
      },
    },
  };

  return createHuman({
    name: "AuditObserver",
    capabilities: ["audit-log"],
    handlers: [handler],
  });
}
