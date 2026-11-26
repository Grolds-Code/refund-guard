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
      event.type === "model.answer" ||
      event.type === "interception.started" ||
      event.type === "interception.finished"
    );
  }
}

/**
 * Non-blocking Mozaik observer participant that tracks exact agent loop
 * completion windows (for concurrency overlap verification) and records
 * runtime lifecycle events into the shared audit timeline.
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
          const payload = event.payload as { answer?: { content?: { text?: string } } } | undefined;
          const text = payload?.answer?.content?.text ?? "";

          if (event.producerId === refundDeskId) {
            const openWindow = state.refundDeskWindows.find((w) => !w.endedAtMs);
            if (openWindow) {
              openWindow.endedAtMs = Date.now();
            }
            state.recordEvent(
              "agent.completed",
              "RefundDeskAgent",
              text.slice(0, 220) || "RefundDeskAgent loop completed.",
            );
            state.notifyRefundDeskLoopSettled();
          } else if (event.producerId === sentinelId) {
            const openWindow = state.sentinelWindows.find((w) => !w.endedAtMs);
            if (openWindow) {
              openWindow.endedAtMs = Date.now();
            }
            state.recordEvent(
              "agent.completed",
              "DisputeFulfillmentSentinel",
              text.slice(0, 220) || "DisputeFulfillmentSentinel loop completed.",
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
