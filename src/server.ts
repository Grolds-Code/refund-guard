import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getScenarioById, SCENARIOS } from "./finance/fixtures.js";
import type { MidFlightInjection, SellerId } from "./finance/types.js";
import { runSingleAgentBaseline } from "./engine/baseline.js";
import {
  buildInjectedChargeback,
  buildInjectedWarehouseCorrection,
  runRefundGuardCase,
} from "./engine/run-case.js";
import { resolveInferenceMode } from "./mozaik/runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_INDEX = join(__dirname, "..", "public", "index.html");
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);

interface RunRequestBody {
  scenarioId: string;
  customWarehouseNoteText?: string;
  overrideDraftSellerId?: SellerId;
  injectionMode?:
    | "scenario-default"
    | "none"
    | "chargeback"
    | "correction-seller-a"
    | "correction-seller-b";
  modeOverride?: "auto" | "live" | "mock";
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

const server = createServer(async (req, res) => {
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
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/scenarios") {
      const resolved = resolveInferenceMode();
      sendJson(res, 200, {
        mode: resolved.mode,
        model: resolved.modelName,
        scenarios: SCENARIOS,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/compare") {
      const results = [];
      for (const scenario of SCENARIOS) {
        const [baseline, guard] = await Promise.all([
          runSingleAgentBaseline(scenario, { latencyScale: 0.4 }),
          runRefundGuardCase(scenario, { latencyScale: 0.4 }),
        ]);
        results.push({
          scenarioId: scenario.id,
          shortLabel: scenario.shortLabel,
          title: scenario.title,
          baseline: {
            verdict: baseline.verdict,
            debitSellerId: baseline.acceptedProposal?.debitSellerId ?? null,
            durationMs: baseline.durationMs,
          },
          guard: {
            verdict: guard.verdict,
            debitSellerId: guard.acceptedProposal?.debitSellerId ?? null,
            interceptions: guard.interceptions.map((i) => i.reason),
            concurrentOverlapVerified: guard.concurrentOverlapVerified,
            overlapDetail: guard.overlapDetail,
            misallocationCaughtKsh: guard.ledger.misallocationCaughtKsh,
            doublePayoutPreventedKsh: guard.ledger.doublePayoutPreventedKsh,
            heldAmountKsh: guard.ledger.heldAmountKsh,
            durationMs: guard.durationMs,
          },
        });
      }
      sendJson(res, 200, { results });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const body = await readJsonBody<RunRequestBody>(req);
      const scenario = getScenarioById(body.scenarioId ?? SCENARIOS[1].id);

      let overrideInjection: MidFlightInjection | null | undefined = undefined;
      if (body.injectionMode === "none") {
        overrideInjection = null;
      } else if (body.injectionMode === "chargeback") {
        overrideInjection = {
          delayMs: 110,
          kind: "CHARGEBACK_WEBHOOK",
          chargeback: buildInjectedChargeback(scenario),
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

      const latencyScale = body.modeOverride === "live" ? 1 : 3.2;

      const [report, baseline] = await Promise.all([
        runRefundGuardCase(scenario, {
          modeOverride: body.modeOverride,
          latencyScale,
          customWarehouseNoteText: body.customWarehouseNoteText,
          overrideDraftSellerId: body.overrideDraftSellerId,
          overrideInjection,
          onTimeline: (entry) => writeSse("timeline", entry),
        }),
        runSingleAgentBaseline(
          {
            ...scenario,
            draft:
              body.overrideDraftSellerId &&
              body.overrideDraftSellerId !== scenario.draft.debitedSellerId
                ? {
                    ...scenario.draft,
                    debitedSellerId: body.overrideDraftSellerId,
                  }
                : scenario.draft,
            midFlightInjection:
              overrideInjection === undefined
                ? scenario.midFlightInjection
                : (overrideInjection ?? undefined),
          },
          { modeOverride: body.modeOverride, latencyScale: 0.4 },
        ),
      ]);

      writeSse("report", { report, baseline });
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

server.listen(PORT, () => {
  const resolved = resolveInferenceMode();
  console.log(`\nRefundGuard interactive demo running on http://localhost:${PORT}`);
  console.log(`Inference mode: ${resolved.mode} (${resolved.modelName})`);
  console.log(`Loaded ${SCENARIOS.length} Black Friday scenarios. Press Ctrl+C to stop.\n`);
});
