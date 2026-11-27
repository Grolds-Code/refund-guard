import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BLACK_FRIDAY_BATCH_CHECKOUTS } from "./finance/batch.js";
import {
  createAmbiguousDisputeFixture,
  createUnrelatedDisputeFixture,
  getScenarioById,
  SCENARIOS,
} from "./finance/fixtures.js";
import type { MidFlightInjection, ScenarioFixture, SellerId } from "./finance/types.js";
import {
  runSingleAgentSnapshotBaseline,
  runTicketAndDraftBaseline,
} from "./engine/baseline.js";
import { runBlackFridayBatch, type OperatorDecision } from "./engine/run-batch.js";
import {
  buildInjectedChargeback,
  buildInjectedWarehouseCorrection,
  runRefundGuardCase,
  type PostAcceptanceInjector,
} from "./engine/run-case.js";
import { resolveInferenceMode } from "./mozaik/runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_INDEX = join(__dirname, "..", "public", "index.html");
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const MAX_RETAINED_SESSIONS = 100;

interface StoredSession {
  id: string;
  createdAt: number;
  scenario: ScenarioFixture;
  injector: PostAcceptanceInjector;
  injectedNotes: Array<{
    noteId: string;
    receivedAt: string;
    hub: string;
    text: string;
    supersedesNoteId?: string;
  }>;
  injectedDispute: ReturnType<typeof buildInjectedChargeback> | null;
  operatorDecision: OperatorDecision;
  approvedEpoch: number | null;
}

interface RunRequestBody {
  scenarioId: string;
  customWarehouseNoteText?: string;
  overrideDraftSellerId?: SellerId;
  slowDemo?: boolean;
  injectionMode?:
    | "scenario-default"
    | "none"
    | "chargeback"
    | "chargeback-unrelated"
    | "chargeback-ambiguous"
    | "correction-seller-a"
    | "correction-seller-b";
  modeOverride?: "auto" | "live" | "mock";
}

interface LiveInjectBody {
  kind: "WAREHOUSE_CORRECTION" | "CHARGEBACK_MATCHING" | "CHARGEBACK_UNRELATED";
  targetSellerId?: SellerId;
}

interface ApproveRequestBody {
  epoch?: number;
  decision?: OperatorDecision;
}

function resolveAnyScenario(id: string): ScenarioFixture {
  const fromBatch = BLACK_FRIDAY_BATCH_CHECKOUTS.find((s) => s.id === id);
  if (fromBatch) return fromBatch;
  return getScenarioById(id);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return (raw ? JSON.parse(raw) : {}) as T;
}

export function createRefundGuardServer(): Server {
  // Retained across completed runs so post-run disputes and server-side `/approve`
  // epoch checks can enforce 409 Conflict when an approval expires.
  const sessions = new Map<string, StoredSession>();

  const retainSession = (session: StoredSession) => {
    sessions.set(session.id, session);
    if (sessions.size > MAX_RETAINED_SESSIONS) {
      const oldestKey = sessions.keys().next().value;
      if (oldestKey) sessions.delete(oldestKey);
    }
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/") {
        const html = await readFile(PUBLIC_INDEX, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        const resolved = resolveInferenceMode();
        sendJson(res, 200, {
          ok: true,
          mode: resolved.mode,
          model: resolved.modelName,
          scenarios: SCENARIOS.length,
          batchCheckouts: BLACK_FRIDAY_BATCH_CHECKOUTS.length,
          retainedSessions: sessions.size,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/scenarios") {
        const resolved = resolveInferenceMode();
        sendJson(res, 200, {
          mode: resolved.mode,
          model: resolved.modelName,
          scenarios: SCENARIOS,
          batchCheckouts: BLACK_FRIDAY_BATCH_CHECKOUTS,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/batch") {
        const batchSummary = await runBlackFridayBatch({ latencyScale: 0.7 });
        sendJson(res, 200, batchSummary);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/compare") {
        const results = [];
        for (const scenario of SCENARIOS) {
          const [ticketDraft, snapshot, guard] = await Promise.all([
            runTicketAndDraftBaseline(scenario, { latencyScale: 0.4 }),
            runSingleAgentSnapshotBaseline(scenario, { latencyScale: 0.4 }),
            runRefundGuardCase(scenario, { latencyScale: 0.4 }),
          ]);
          results.push({
            scenarioId: scenario.id,
            shortLabel: scenario.shortLabel,
            title: scenario.title,
            ticketDraft: {
              verdict: ticketDraft.verdict,
              debitSellerId: ticketDraft.acceptedProposal?.debitSellerId ?? null,
              supportedTotalKsh: ticketDraft.ledger.supportedTotalKsh,
            },
            snapshot: {
              verdict: snapshot.verdict,
              debitSellerId: snapshot.acceptedProposal?.debitSellerId ?? null,
              supportedTotalKsh: snapshot.ledger.supportedTotalKsh,
            },
            guard: {
              verdict: guard.verdict,
              debitSellerId: guard.acceptedProposal?.debitSellerId ?? null,
              interceptions: guard.interceptions.map((i) => i.reason),
              concurrentOverlapVerified: guard.concurrentOverlapVerified,
              overlapDetail: guard.overlapDetail,
              misallocationCaughtKsh: guard.ledger.misallocationCaughtKsh,
              blockedUnsafeRefundKsh: guard.ledger.blockedUnsafeRefundKsh,
              heldReserveKsh: guard.ledger.heldReserveKsh,
              supportedTotalKsh: guard.ledger.supportedTotalKsh,
              reconciliationMatched: guard.ledger.reconciliationMatched,
              durationMs: guard.durationMs,
            },
          });
        }
        sendJson(res, 200, { results });
        return;
      }

      // Live mid-run OR post-run event injection into a session
      const injectMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/inject$/);
      if (req.method === "POST" && injectMatch) {
        const sessionId = injectMatch[1];
        const session = sessions.get(sessionId);
        if (!session) {
          sendJson(res, 404, { error: "Review session not found." });
          return;
        }
        const body = await readJsonBody<LiveInjectBody>(req);
        if (body.kind === "WAREHOUSE_CORRECTION") {
          const note = buildInjectedWarehouseCorrection(
            session.scenario,
            body.targetSellerId ?? "SELLER-A",
          );
          session.injectedNotes.push(note);
          const resInj = session.injector.injectWarehouseCorrection(note);
          if (resInj.invalidatedPriorApproval) {
            session.operatorDecision = "PENDING";
            session.approvedEpoch = null;
          }
          const snap = session.injector.getCurrentSnapshot();
          sendJson(res, 200, {
            ok: true,
            injected: "WAREHOUSE_CORRECTION",
            noteId: note.noteId,
            epoch: resInj.epoch,
            invalidatedPriorApproval: resInj.invalidatedPriorApproval,
            currentVerdict: snap.verdict,
            approvable: snap.approvable,
            report: snap.report,
          });
          return;
        }
        if (body.kind === "CHARGEBACK_MATCHING") {
          const cb = buildInjectedChargeback(session.scenario);
          session.injectedDispute = cb;
          const resInj = session.injector.injectChargeback(cb);
          if (resInj.invalidatedPriorApproval) {
            session.operatorDecision = "PENDING";
            session.approvedEpoch = null;
          }
          const snap = session.injector.getCurrentSnapshot();
          sendJson(res, 200, {
            ok: true,
            injected: "CHARGEBACK_MATCHING",
            disputeId: cb.disputeId,
            epoch: resInj.epoch,
            invalidatedPriorApproval: resInj.invalidatedPriorApproval,
            currentVerdict: snap.verdict,
            approvable: snap.approvable,
            report: snap.report,
          });
          return;
        }
        if (body.kind === "CHARGEBACK_UNRELATED") {
          const cb = createUnrelatedDisputeFixture();
          session.injectedDispute = cb;
          const resInj = session.injector.injectChargeback(cb);
          const snap = session.injector.getCurrentSnapshot();
          sendJson(res, 200, {
            ok: true,
            injected: "CHARGEBACK_UNRELATED",
            disputeId: cb.disputeId,
            epoch: resInj.epoch,
            invalidatedPriorApproval: resInj.invalidatedPriorApproval,
            currentVerdict: snap.verdict,
            approvable: snap.approvable,
            report: snap.report,
          });
          return;
        }
        sendJson(res, 400, { error: "Unsupported injection kind" });
        return;
      }

      // Server-side approval / operator decision gate with strict epoch & verdict enforcement
      const approveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(approve|decision)$/);
      if (req.method === "POST" && approveMatch) {
        const sessionId = approveMatch[1];
        const session = sessions.get(sessionId);
        if (!session) {
          sendJson(res, 404, { error: "Review session not found." });
          return;
        }
        const body = await readJsonBody<ApproveRequestBody>(req);
        const decision: OperatorDecision = body.decision ?? "APPROVED_FOR_RELEASE";
        const snap = session.injector.getCurrentSnapshot();

        if (decision === "APPROVED_FOR_RELEASE") {
          if (typeof body.epoch !== "number" || !Number.isInteger(body.epoch)) {
            sendJson(res, 400, {
              ok: false,
              code: "MISSING_EPOCH",
              error: "Approval request must specify the reviewed integer epoch.",
            });
            return;
          }
          if (body.epoch !== snap.epoch) {
            sendJson(res, 409, {
              ok: false,
              code: "APPROVAL_EXPIRED_STALE_EPOCH",
              error: `409 Conflict: approval expired. Reviewed epoch ${body.epoch} was superseded by epoch ${snap.epoch} (${snap.verdict}). Re-run review before approving.`,
              requestedEpoch: body.epoch,
              currentEpoch: snap.epoch,
              currentVerdict: snap.verdict,
              approvable: snap.approvable,
            });
            return;
          }
          if (!snap.approvable) {
            sendJson(res, 409, {
              ok: false,
              code: "VERDICT_NOT_APPROVABLE",
              error: `409 Conflict: payout release cannot be approved while verdict is ${snap.verdict}${!snap.reconciliationMatched ? " (money reconciliation failed)" : ""}.`,
              currentEpoch: snap.epoch,
              currentVerdict: snap.verdict,
              approvable: false,
            });
            return;
          }

          session.operatorDecision = "APPROVED_FOR_RELEASE";
          session.approvedEpoch = snap.epoch;
          sendJson(res, 200, {
            ok: true,
            decision: session.operatorDecision,
            epoch: snap.epoch,
            verdict: snap.verdict,
            approvedReleaseKsh: snap.report.ledger.supportedTotalKsh,
          });
          return;
        }

        if (decision === "HELD_IN_RESERVE" || decision === "REJECTED") {
          session.operatorDecision = decision;
          session.approvedEpoch = null;
          sendJson(res, 200, {
            ok: true,
            decision: session.operatorDecision,
            epoch: snap.epoch,
            verdict: snap.verdict,
          });
          return;
        }

        sendJson(res, 400, { error: "Unsupported operator decision." });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/run") {
        const body = await readJsonBody<RunRequestBody>(req);
        const scenario = resolveAnyScenario(body.scenarioId ?? SCENARIOS[1].id);
        const sessionId = randomUUID();

        let overrideInjection: MidFlightInjection | null | undefined = undefined;
        if (body.injectionMode === "none") {
          overrideInjection = null;
        } else if (body.injectionMode === "chargeback") {
          overrideInjection = {
            delayMs: 110,
            kind: "CHARGEBACK_WEBHOOK",
            chargeback: buildInjectedChargeback(scenario),
          };
        } else if (body.injectionMode === "chargeback-unrelated") {
          overrideInjection = {
            delayMs: 110,
            kind: "CHARGEBACK_WEBHOOK",
            chargeback: createUnrelatedDisputeFixture(),
          };
        } else if (body.injectionMode === "chargeback-ambiguous") {
          overrideInjection = {
            delayMs: 110,
            kind: "CHARGEBACK_WEBHOOK",
            chargeback: createAmbiguousDisputeFixture(),
          };
        } else if (body.injectionMode === "correction-seller-a") {
          overrideInjection = {
            delayMs: 110,
            kind: "WAREHOUSE_CORRECTION",
            warehouseNote: buildInjectedWarehouseCorrection(scenario, "SELLER-A"),
          };
        } else if (body.injectionMode === "correction-seller-b") {
          overrideInjection = {
            delayMs: 110,
            kind: "WAREHOUSE_CORRECTION",
            warehouseNote: buildInjectedWarehouseCorrection(scenario, "SELLER-B"),
          };
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });

        const writeSse = (eventName: string, data: unknown) => {
          res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        writeSse("session", { sessionId, scenarioId: scenario.id });

        const latencyScale = body.modeOverride === "live" ? 1 : body.slowDemo ? 14 : 3.2;

        const overriddenScenario = {
          ...scenario,
          draft:
            body.overrideDraftSellerId &&
            body.overrideDraftSellerId !== scenario.draft.debitedSellerId
              ? {
                  ...scenario.draft,
                  debitedSellerId: body.overrideDraftSellerId,
                }
              : scenario.draft,
          initialWarehouseNote:
            body.customWarehouseNoteText &&
            body.customWarehouseNoteText.trim().length > 0 &&
            body.customWarehouseNoteText.trim() !== scenario.initialWarehouseNote.text.trim()
              ? {
                  ...scenario.initialWarehouseNote,
                  noteId: `${scenario.initialWarehouseNote.noteId}-EDIT`,
                  text: body.customWarehouseNoteText.trim(),
                }
              : scenario.initialWarehouseNote,
          midFlightInjection:
            overrideInjection === undefined
              ? scenario.midFlightInjection
              : (overrideInjection ?? undefined),
        };

        let sessionRecord: StoredSession | undefined;
        const [report, snapshotBaseline] = await Promise.all([
          runRefundGuardCase(scenario, {
            modeOverride: body.modeOverride,
            latencyScale,
            customWarehouseNoteText: body.customWarehouseNoteText,
            overrideDraftSellerId: body.overrideDraftSellerId,
            overrideInjection,
            onSessionReady: (injector) => {
              sessionRecord = {
                id: sessionId,
                createdAt: Date.now(),
                scenario: overriddenScenario,
                injector,
                injectedNotes: [],
                injectedDispute: null,
                operatorDecision: "PENDING",
                approvedEpoch: null,
              };
              retainSession(sessionRecord);
            },
            onTimeline: (entry) => writeSse("timeline", entry),
          }),
          runSingleAgentSnapshotBaseline(overriddenScenario, {
            modeOverride: body.modeOverride,
            latencyScale: 0.4,
          }),
        ]);

        const allNotes = [overriddenScenario.initialWarehouseNote];
        if (overriddenScenario.midFlightInjection?.warehouseNote) {
          allNotes.push(overriddenScenario.midFlightInjection.warehouseNote);
        }
        if (sessionRecord) {
          allNotes.push(...sessionRecord.injectedNotes);
        }

        writeSse("report", {
          sessionId,
          report,
          baseline: snapshotBaseline,
          approvable:
            (report.verdict === "READY_FOR_HUMAN_APPROVAL" ||
              report.verdict === "CORRECTED_READY_FOR_APPROVAL") &&
            report.ledger.reconciliationMatched,
          sourceRecords: {
            settlements: overriddenScenario.settlements,
            orderLines: overriddenScenario.orderLines,
            warehouseNotes: allNotes,
            dispute:
              sessionRecord?.injectedDispute ??
              overriddenScenario.midFlightInjection?.chargeback ??
              overriddenScenario.initialChargeback ??
              null,
          },
        });

        res.end();
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      } else {
        res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        res.end();
      }
    }
  });
}

const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url).replace(/\\/g, "/") ===
    process.argv[1].replace(/\\/g, "/");

if (isDirectExecution) {
  const server = createRefundGuardServer();
  server.listen(PORT, () => {
    const resolved = resolveInferenceMode();
    console.log(`\nRefundGuard interactive demo running on http://localhost:${PORT}`);
    console.log(`Inference mode: ${resolved.mode} (${resolved.modelName})`);
    console.log(
      `Loaded ${SCENARIOS.length} scenarios + ${BLACK_FRIDAY_BATCH_CHECKOUTS.length}-checkout Black Friday batch. Press Ctrl+C to stop.\n`,
    );
  });
}
