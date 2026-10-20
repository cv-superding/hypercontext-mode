/**
 * Real-client end-to-end: the actual OpenCode CLI, N turns, against a local
 * mock upstream — once direct, once through the compression proxy.
 *
 * Why this matters: OpenCode (like Claude Code and Codex) compacts the
 * conversation on its OWN before the model's window is full. This bench
 * measures what HyperContext adds ON TOP of that host-side compaction:
 *
 *   1. when the host compacts (token level, per turn),
 *   2. what the host's request looks like before/after the compaction,
 *   3. whether the pre-compaction content is still retrievable afterwards
 *      (`hc_search` over the compression index) — the one thing the host's
 *      own lossy compaction cannot give back,
 *   4. the byte/token A/B between the direct path and the proxied path.
 *
 * The upstream is a LOCAL MOCK: no provider is billed and no real model is
 * involved. The mock reports truthful token counts (derived from the bytes it
 * actually received), so OpenCode's own compaction accounting stays honest.
 *
 *   node tools/bench-opencode-e2e.mjs [--turns 12] [--window 16000]
 *                                    [--chunk 8000] [--json docs/bench/opencode-e2e.json]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, getEnginePaths, resolveSessionIdentity } from "@hypercontext/core";
import { fetchProxyOverview } from "@hypercontext/runtime";

const repoRoot = join(import.meta.dirname, "..");
const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const turns = Number(argOf("turns", "14"));
const windowTokens = Number(argOf("window", "24000"));
// Windows caps the command line at ~8 KB, so the per-turn prompt has to stay
// small; the conversation grows over MANY turns instead (which is also what a
// real long session looks like).
const chunkBytes = Number(argOf("chunk", "4000"));
const modelId = argOf("model", "opencode/big-pickle");
const providerId = modelId.split("/")[0];
const jsonOut = argOf("json", "");

const home = mkdtempSync(join(tmpdir(), "hctx-oc-e2e-"));
const workDir = join(home, "work");
const sessionsDir = join(home, "data", "compression", "sessions");
mkdirSync(workDir, { recursive: true });
mkdirSync(sessionsDir, { recursive: true });
process.env.HYPERCONTEXT_HOME = home;

const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";
const needle = "NEEDLE-ALPHA-7731";

/* ------------------------------------------------------------------ mock */

const upstream = await startMockUpstream();

/* ------------------------------------------------------------------ run A (direct) */

const directConfig = join(home, "opencode.direct.json");
writeOpencodeConfig(directConfig, `${upstream.url}/v1`);
const direct = await runSession("direct", directConfig, turns);

/* ------------------------------------------------------------------ run B (proxy) */

const proxyPort = await freePort();
const engineConfig = join(home, "engine.json");
writeFileSync(
  engineConfig,
  JSON.stringify({
    autoUpdate: false,
    advisoryCheck: false,
    releaseNotesCheck: false,
    providers: {},
    compress: { injectTool: true, injectNudge: true },
  }, null, 2),
);
const proxy = spawn(
  process.execPath,
  [getEnginePaths().billionContext.distEntry, "start", "--port", String(proxyPort), "--host", "127.0.0.1"],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      BILI_CONFIG_FILE: engineConfig,
      BILI_SESSIONS_DIR: sessionsDir,
      ACP_UPSTREAM: upstream.url,
      ACP_MODEL_CONTEXT_LIMIT: String(windowTokens),
      ACP_INJECT_AFTER_TOKENS: "0",
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let proxyLog = "";
proxy.stdout.on("data", (chunk) => { proxyLog += chunk.toString(); });
proxy.stderr.on("data", (chunk) => { proxyLog += chunk.toString(); });

let proxied;
let overview = null;
try {
  const origin = `http://127.0.0.1:${proxyPort}`;
  if (!(await waitHealthy(origin, 30_000))) {
    throw new Error(`proxy did not become healthy\n${proxyLog.slice(-4000)}`);
  }
  const proxyConfig = join(home, "opencode.proxy.json");
  writeOpencodeConfig(proxyConfig, `${origin}/bili/${upstream.url}/v1`);
  const before = upstream.bodies.length;
  proxied = await runSession("proxied", proxyConfig, turns);
  proxied.bodies = upstream.bodies.slice(before);
  overview = await fetchProxyOverview(origin, 10_000);
} finally {
  if (proxy.exitCode === null) {
    proxy.kill();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

/* ------------------------------------------------------------------ run C (proxy + autoFold) */

const autofoldConfig = join(home, "engine.autofold.json");
writeFileSync(
  autofoldConfig,
  JSON.stringify({
    autoUpdate: false,
    advisoryCheck: false,
    releaseNotesCheck: false,
    providers: {
      "bench-summary": {
        baseUrl: `${upstream.url}/v1`,
        api: "openai",
        apiKeyEnv: "BENCH_SUMMARY_KEY",
        models: { "mock-summary": {} },
      },
    },
    compress: {
      injectTool: false,
      injectNudge: false,
      externalSummary: {
        enabled: true,
        targets: ["bench-summary/mock-summary"],
        autoFold: true,
        autoFoldTargetTokens: Math.max(4096, Math.floor(windowTokens / 2)),
        concurrency: 4,
      },
    },
  }, null, 2),
);
const autofoldPort = await freePort();
const autofoldProxy = spawn(
  process.execPath,
  [getEnginePaths().billionContext.distEntry, "start", "--port", String(autofoldPort), "--host", "127.0.0.1"],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      BILI_CONFIG_FILE: autofoldConfig,
      BILI_SESSIONS_DIR: join(home, "data", "compression", "sessions-autofold"),
      ACP_UPSTREAM: upstream.url,
      ACP_MODEL_CONTEXT_LIMIT: String(windowTokens),
      BENCH_SUMMARY_KEY: "bench-key",
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let autofoldLog = "";
autofoldProxy.stdout.on("data", (chunk) => { autofoldLog += chunk.toString(); });
autofoldProxy.stderr.on("data", (chunk) => { autofoldLog += chunk.toString(); });

let autofold;
let autofoldOverview = null;
try {
  const origin = `http://127.0.0.1:${autofoldPort}`;
  if (!(await waitHealthy(origin, 30_000))) {
    throw new Error(`autoFold proxy did not become healthy\n${autofoldLog.slice(-4000)}`);
  }
  const config = join(home, "opencode.autofold.json");
  writeOpencodeConfig(config, `${origin}/bili/${upstream.url}/v1`);
  const before = upstream.bodies.length;
  autofold = await runSession("autofold", config, turns);
  autofold.bodies = upstream.bodies.slice(before);
  autofoldOverview = await fetchProxyOverview(origin, 10_000);
} finally {
  if (autofoldProxy.exitCode === null) {
    autofoldProxy.kill();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

/* ------------------------------------------------------------------ analysis */

const directAnalysis = analyze(direct, upstream.bodies.slice(0, direct.bodies.length));
const proxiedAnalysis = analyze(proxied, proxied.bodies);
const autofoldAnalysis = analyze(autofold, autofold.bodies);

const searchable = await searchNeedle(home, sessionsDir, needle);
const searchableAutofold = await searchNeedle(home, join(home, "data", "compression", "sessions-autofold"), needle);

const report = {
  generatedAt: new Date().toISOString(),
  client: { name: "opencode", version: await opencodeVersion(), model: modelId },
  setup: {
    turns,
    modelContextWindow: windowTokens,
    promptBytesPerTurn: chunkBytes,
    provider: { billed: false, note: "local mock upstream — no provider tokens are billed" },
  },
  direct: directAnalysis,
  proxied: proxiedAnalysis,
  autofold: autofoldAnalysis,
  comparison: {
    directRequests: directAnalysis.requests,
    proxiedRequests: proxiedAnalysis.requests,
    autofoldRequests: autofoldAnalysis.requests,
    directCompactions: directAnalysis.compactions.length,
    proxiedCompactions: proxiedAnalysis.compactions.length,
    autofoldCompactions: autofoldAnalysis.compactions.length,
    directTotalRequestBytes: directAnalysis.totalRequestBytes,
    proxiedTotalRequestBytes: proxiedAnalysis.totalRequestBytes,
    autofoldTotalRequestBytes: autofoldAnalysis.totalRequestBytes,
  },
  hostCompaction: {
    detectedInDirectRun: directAnalysis.compactions.length,
    detectedInProxiedRun: proxiedAnalysis.compactions.length,
    detectedInAutoFoldRun: autofoldAnalysis.compactions.length,
    firstCompaction: directAnalysis.compactions[0] ?? null,
  },
  retrievability: {
    proxiedRun: searchable,
    autoFoldRun: searchableAutofold,
  },
  engine: overview
    ? {
        requests: overview.requests,
        blocks: overview.blocks,
        grossSaved: overview.grossSaved,
        netSaved: overview.netSaved,
        injectedOverheadTokens: overview.injectedOverheadTokens,
        summaryCalls: overview.summaryCalls,
        summaryInputTokens: overview.summaryInputTokens,
        postFoldRequests: overview.postFoldRequests,
      }
    : null,
  engineAutoFold: autofoldOverview
    ? {
        requests: autofoldOverview.requests,
        blocks: autofoldOverview.blocks,
        grossSaved: autofoldOverview.grossSaved,
        netSaved: autofoldOverview.netSaved,
        injectedOverheadTokens: autofoldOverview.injectedOverheadTokens,
        summaryCalls: autofoldOverview.summaryCalls,
        summaryInputTokens: autofoldOverview.summaryInputTokens,
        summaryOutputTokens: autofoldOverview.summaryOutputTokens,
        postFoldRequests: autofoldOverview.postFoldRequests,
      }
    : null,
};

if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

upstream.server.close();
if (process.env.HCTX_OC_KEEP) console.error(`kept ${home}`);
else rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/* ------------------------------------------------------------------ helpers */

function writeOpencodeConfig(file, baseURL) {
  writeFileSync(
    file,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          [providerId]: {
            options: { baseURL, apiKey: "bench-key" },
            models: {
              [modelId.split("/")[1]]: { limit: { context: windowTokens, output: 4096 } },
            },
          },
        },
        model: modelId,
        compaction: { auto: true },
      },
      null,
      2,
    ),
  );
}

async function runSession(label, configPath, count) {
  const invocations = [];
  const failures = [];
  const bodies = [];
  let sessionId = "";
  const before = upstream.bodies.length;
  for (let turn = 0; turn < count; turn += 1) {
    const prompt = buildPrompt(turn);
    const args = ["run", "--model", modelId, "--format", "json"];
    if (sessionId) args.push("--session", sessionId);
    args.push(prompt);
    const result = await runOpencode(args, configPath);
    process.stderr.write(`[${label}] turn ${turn + 1}: exit=${result.code} session=${sessionId} out=${result.stdout.length}B err=${JSON.stringify(result.stderr.slice(0, 300))}\n`);
    invocations.push({ turn: turn + 1, code: result.code, stderr: result.stderr.slice(-300) });
    if (result.code !== 0) failures.push({ turn: turn + 1, code: result.code, stderr: result.stderr.slice(-300) });
    const found = result.stdout.match(/"sessionID":"([^"]+)"/);
    if (found) sessionId = found[1];
  }
  return { label, sessionId, invocations, failures, bodies: upstream.bodies.slice(before) };
}

function buildPrompt(turn) {
  const marker = turn === 0 ? ` ${needle} ` : " ";
  const filler = "x".repeat(chunkBytes);
  return `Turn ${turn + 1}${marker}Remember this context block. ${filler}\nReply with exactly: PONG`;
}

function runOpencode(args, configPath) {
  return new Promise((resolve) => {
    const child = spawn(opencodeBin, args, {
      cwd: workDir,
      env: {
        ...process.env,
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_CONTENT: "",
        OPENCODE_SESSION_ID: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32") spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
        else child.kill("SIGKILL");
      } catch {
        // the shell wrapper may already be gone
      }
    }, 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** A host-side compaction shows up on the wire as a prompt-size DROP: the
 *  client replaces the history with a summary, so the next request is
 *  smaller than the previous one even though the turn count grew. */
function analyze(run, bodies) {
  const perTurn = bodies.map((body) => ({
    messages: (body.messages ?? []).length,
    bytes: JSON.stringify(body).length,
    promptTokens: body.__promptTokens ?? null,
  }));
  const compactions = [];
  for (let index = 1; index < perTurn.length; index += 1) {
    const previous = perTurn[index - 1];
    const current = perTurn[index];
    if (previous.bytes > 0 && current.bytes < previous.bytes * 0.75) {
      compactions.push({
        atRequest: index + 1,
        bytesBefore: previous.bytes,
        bytesAfter: current.bytes,
        messagesBefore: previous.messages,
        messagesAfter: current.messages,
        dropPct: Math.round(((previous.bytes - current.bytes) / previous.bytes) * 1000) / 10,
      });
    }
  }
  return {
    requests: bodies.length,
    invocations: run.invocations.length,
    failures: run.failures.length,
    sessionId: run.sessionId,
    totalRequestBytes: perTurn.reduce((sum, item) => sum + item.bytes, 0),
    perTurn,
    compactions,
  };
}

/** Can the pre-compaction content still be found after the host compacted? */
async function searchNeedle(hyperHome, engineSessionsDir, marker) {
  const previous = process.env.HYPERCONTEXT_HOME;
  process.env.HYPERCONTEXT_HOME = hyperHome;
  try {
    const { federatedSearch } = await import("@hypercontext/core");
    const result = federatedSearch({ query: marker, limit: 20, allSessions: true });
    const identity = resolveSessionIdentity({ projectDir: hyperHome });
    return {
      marker,
      hits: result.hits.map((hit) => ({ layer: hit.layer, kind: hit.kind, source: hit.source })),
      found: result.hits.length > 0,
      diagnostics: {
        compressionIndex: result.diagnostics.compressionIndex,
        sessionDbs: result.diagnostics.sessionDbs,
        errors: result.diagnostics.errors,
      },
      identity: { sandboxSessionId: identity.sandboxSessionId, matched: identity.matched },
      indexPresent: existsSync(join(engineSessionsDir, "index.db")),
    };
  } finally {
    if (previous === undefined) delete process.env.HYPERCONTEXT_HOME;
    else process.env.HYPERCONTEXT_HOME = previous;
  }
}

async function opencodeVersion() {
  return new Promise((resolve) => {
    const child = spawn(opencodeBin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], shell: true });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.on("close", () => resolve(out.trim()));
  });
}

function startMockUpstream() {
  return new Promise((resolve) => {
    const bodies = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch {}
        const promptTokens = Math.ceil(raw.length / 4);
        bodies.push({ ...parsed, __promptTokens: promptTokens, __bytes: raw.length });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const base = { id: "chatcmpl-bench", object: "chat.completion.chunk", created: Date.now(), model: parsed.model ?? "mock" };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "PONG " + "SUMMARY OF THE COMPRESSED RANGE. ".repeat(12) } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 2, total_tokens: promptTokens + 2 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, bodies }));
  });
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
