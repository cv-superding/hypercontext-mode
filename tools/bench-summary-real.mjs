/**
 * Real summarizer benchmark (local Ollama, no billing claims).
 *
 * Runs the built engine's auto-fold path with a REAL summarizer — the local
 * Ollama OpenAI-compatible endpoint — and measures what the summary actually
 * costs in latency and tokens, plus whether it keeps the facts that matter.
 *
 * The token numbers are estimates from the engine's own tokenizer and the
 * latency numbers are real wall-clock measurements. No provider is billed, so
 * this script reports NO money: a local model has no per-token price.
 *
 *   node tools/bench-summary-real.mjs [--json docs/bench/summary-real.json]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultConfig, ensureBillionConfig, getEnginePaths } from "@hypercontext/core";
import { buildMeter, fetchProxyOverview } from "@hypercontext/runtime";

const repoRoot = join(import.meta.dirname, "..");
const ollamaBase = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
const ollamaModel = process.env.OLLAMA_MODEL ?? "qwen2.5:0.5b";
const targetTokens = Number(process.env.SUMMARY_TARGET ?? 8192);
const pairs = Number(process.env.SUMMARY_PAIRS ?? 36);

const FACTS = [
  "the wifi passphrase is hunter2",
  "the UPS model is APC Back-UPS Pro 1500",
  "the GPU driver version is 550.54.14",
  "the release deadline is 2026-11-02",
  "the failing test is tests/parser.test.ts",
  "the database host is db.internal.example:5432",
  "the feature flag is HYPERCONTEXT_LEAN_V2",
  "the rollback plan is git revert 9f3c1de",
];

const home = mkdtempSync(join(tmpdir(), "hctx-summary-real-"));
const sessionsDir = join(home, "sessions");
mkdirSync(sessionsDir, { recursive: true });
process.env.HYPERCONTEXT_HOME = home;

if (!(await ollamaReachable())) {
  console.error(`Ollama is not reachable at ${ollamaBase}. Start it (ollama serve) and pull ${ollamaModel}.`);
  process.exit(2);
}

// The first call pays the model load; the benchmark measures the steady state.
const warmupStarted = Date.now();
const warmup = await fetch(`${ollamaBase}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer local" },
  body: JSON.stringify({ model: ollamaModel, messages: [{ role: "user", content: "ping" }], max_tokens: 8 }),
}).then((r) => r.json()).catch(() => null);
const warmupMs = Date.now() - warmupStarted;

const proxyPort = await freePort();
const main = await startMainUpstream();

const config = defaultConfig();
config.compression.mode = "autofold";
config.compression.summary = {
  baseUrl: ollamaBase,
  api: "openai",
  apiKeyEnv: "SUMMARY_REAL_KEY",
  model: ollamaModel,
  autoFoldTargetTokens: targetTokens,
  concurrency: 4,
};
const generated = ensureBillionConfig(config);

const proxy = spawn(process.execPath, [getEnginePaths().billionContext.distEntry, "start", "--port", String(proxyPort), "--host", "127.0.0.1"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    BILI_CONFIG_FILE: generated.file,
    BILI_SESSIONS_DIR: sessionsDir,
    ACP_UPSTREAM: main.url,
    ACP_MODEL_CONTEXT_LIMIT: "50000",
    SUMMARY_REAL_KEY: "local-ollama",
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let proxyLog = "";
proxy.stdout.on("data", (chunk) => { proxyLog += chunk.toString(); });
proxy.stderr.on("data", (chunk) => { proxyLog += chunk.toString(); });

try {
  const origin = `http://127.0.0.1:${proxyPort}`;
  if (!(await waitHealthy(origin, 30_000))) {
    throw new Error(`proxy did not become healthy\n${proxyLog.slice(-4000)}`);
  }

  const messages = buildConversation(pairs);
  const sessionId = `summary-real-${Date.now()}`;
  const started = Date.now();
  const response = await fetch(`${origin}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "bench",
      "anthropic-version": "2023-06-01",
      "x-acp-session": sessionId,
    },
    body: JSON.stringify({ model: "test-model", max_tokens: 1024, stream: true, messages }),
  });
  const responseText = await response.text();
  const wallMs = Date.now() - started;

  // A second turn after the fold: this is the request the ledger counts as a
  // post-fold request, and it is what turns "gross saved" into a net number.
  const followUpStarted = Date.now();
  const followUp = await fetch(`${origin}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "bench",
      "anthropic-version": "2023-06-01",
      "x-acp-session": sessionId,
    },
    body: JSON.stringify({ model: "test-model", max_tokens: 1024, stream: true, messages: [...messages, { role: "user", content: [{ type: "text", text: "follow-up question" }] }] }),
  });
  const followUpText = await followUp.text();
  const followUpMs = Date.now() - followUpStarted;

  await new Promise((resolve) => setTimeout(resolve, 500));
  if (process.env.SUMMARY_REAL_LOG) {
    writeFileSync(join(home, "proxy.log"), proxyLog);
    console.error(proxyLog.slice(-6000));
  }

  const forwarded = main.bodies.at(-1) ?? {};
  const overview = await fetchProxyOverview(origin, 10_000);
  const meter = overview ? buildMeter(overview, config) : null;
  const summaryText = readSummaries(sessionsDir);
  const retained = FACTS.filter((fact) => summaryText.toLowerCase().includes(fact.toLowerCase()));

  const report = {
    generatedAt: new Date().toISOString(),
    summarizer: { provider: "ollama (local)", model: ollamaModel, endpoint: ollamaBase, billed: false, warmupMs, warmupOk: Boolean(warmup) },
    status: response.status,
    followUpStatus: followUp.status,
    wallMs,
    followUpMs,
    originalMessages: messages.length,
    forwardedMessages: Array.isArray(forwarded.messages) ? forwarded.messages.length : null,
    systemBytes: Buffer.byteLength(JSON.stringify(forwarded.system ?? ""), "utf8"),
    toolsBytes: Buffer.byteLength(JSON.stringify(forwarded.tools ?? []), "utf8"),
    summary: {
      calls: overview?.summaryCalls ?? null,
      inputTokens: overview?.summaryInputTokens ?? null,
      outputTokens: overview?.summaryOutputTokens ?? null,
      latencyMs: overview?.summaryLatencyMs ?? null,
      averageLatencyMs:
        overview && overview.summaryCalls > 0
          ? Math.round(overview.summaryLatencyMs / overview.summaryCalls)
          : null,
    },
    injectedOverheadTokens: overview?.injectedOverheadTokens ?? null,
    meter: meter
      ? {
          grossSaved: meter.tokens.grossSaved,
          summaryInput: meter.tokens.summaryInput,
          summaryOutput: meter.tokens.summaryCost,
          injectedOverhead: meter.tokens.injectedOverhead,
          netAfterOverhead: meter.tokens.netAfterOverhead,
          postFoldRequests: meter.requests.postFold,
          breakEvenPostFoldRequests: meter.requests.breakEvenPostFoldRequests,
          hasFoldData: meter.hasFoldData,
        }
      : null,
    quality: {
      facts: FACTS.length,
      retained: retained.length,
      recallPct: Math.round((retained.length / FACTS.length) * 1000) / 10,
      retainedFacts: retained,
      missingFacts: FACTS.filter((fact) => !retained.includes(fact)),
      summaryChars: summaryText.length,
    },
    responseBytes: Buffer.byteLength(responseText, "utf8"),
  };

  const jsonFlag = process.argv.indexOf("--json");
  if (jsonFlag >= 0) {
    const out = process.argv[jsonFlag + 1];
    if (!out) throw new Error("--json requires a path");
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (proxy.exitCode === null) {
    proxy.kill();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  main.server.close();
  if (!process.env.SUMMARY_REAL_KEEP) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  else console.error(`kept ${home}`);
}

function buildConversation(count) {
  const filler = "context padding ".repeat(220);
  const messages = [];
  for (let i = 0; i < count; i += 1) {
    const fact = FACTS[i % FACTS.length];
    messages.push({ role: "user", content: [{ type: "text", text: `turn ${i}: remember ${fact}. ${filler}` }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: `ack ${i}` }] });
  }
  messages.push({ role: "user", content: [{ type: "text", text: "final question" }] });
  return messages;
}

function readSummaries(dir) {
  const indexFile = join(dir, "index.db");
  if (!existsSync(indexFile)) return "";
  const db = new DatabaseSync(indexFile, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT payload_json FROM blocks WHERE active = 1")
      .all();
    return rows
      .map((row) => {
        try {
          const payload = JSON.parse(String(row.payload_json ?? "{}"));
          return String(payload.summary ?? payload.text ?? "");
        } catch {
          return "";
        }
      })
      .join("\n");
  } catch {
    return "";
  } finally {
    db.close();
  }
}

async function ollamaReachable() {
  try {
    const response = await fetch(`${ollamaBase}/models`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    const payload = await response.json();
    const models = (payload?.data ?? []).map((entry) => String(entry?.id ?? ""));
    if (!models.includes(ollamaModel)) {
      console.error(`model ${ollamaModel} is not pulled (available: ${models.join(", ") || "none"})`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function startMainUpstream() {
  return new Promise((resolve) => {
    const bodies = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          // keep the byte counter meaningful even for a malformed request
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1000}}}\n\n`);
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n');
        res.write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, bodies }));
  });
}

function waitHealthy(origin, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        const response = await fetch(`${origin}/__bili/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return resolve(true);
      } catch {
        // proxy is still starting
      }
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
}
