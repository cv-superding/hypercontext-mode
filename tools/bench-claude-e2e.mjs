/**
 * Real-client end-to-end run: the actual Claude Code CLI, 30+ turns, through
 * the built compression proxy, against a local mock upstream.
 *
 * What this measures (and what it does NOT):
 *  - MEASURED: how many requests the real client makes, how large each
 *    request is, when the cold-start gate opens, what the proxy measured as
 *    saved/overhead, and the same run WITHOUT the proxy as a byte baseline.
 *  - NOT MEASURED: real provider billing or real model quality. The upstream
 *    is a local mock, so no tokens are billed to anybody.
 *
 *   node tools/bench-claude-e2e.mjs [--turns 30] [--threshold 8000]
 *                                 [--json docs/bench/claude-e2e.json]
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, ensureBillionConfig, getEnginePaths } from "@hypercontext/core";
import { buildMeter, fetchProxyOverview } from "@hypercontext/runtime";

const repoRoot = join(import.meta.dirname, "..");
const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const turns = Number(argOf("turns", "30"));
const threshold = Number(argOf("threshold", "8000"));
const model = argOf("model", "claude-sonnet-4-5");
const claudeBin = process.env.CLAUDE_BIN ?? resolveClaudeBin();
const home = mkdtempSync(join(tmpdir(), "hctx-claude-e2e-"));
const sessionsDir = join(home, "sessions");
const workDir = join(home, "work");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const upstream = await startMockUpstream();
const proxyPort = await freePort();
const config = defaultConfig();
config.compression.mode = "cooperative";
const generated = ensureBillionConfig(config);

const proxy = spawn(process.execPath, [getEnginePaths().billionContext.distEntry, "start", "--port", String(proxyPort), "--host", "127.0.0.1", ...(process.env.E2E_PASSTHROUGH ? ["--passthrough"] : [])], {
  cwd: repoRoot,
  env: {
    ...process.env,
    BILI_CONFIG_FILE: generated.file,
    BILI_SESSIONS_DIR: sessionsDir,
    ACP_UPSTREAM: upstream.url,
    ACP_MODEL_CONTEXT_LIMIT: "200000",
    ACP_INJECT_AFTER_TOKENS: String(threshold),
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
  if (process.env.E2E_LOG) {
    proxy.stdout.on("data", (chunk) => { process.stderr.write(chunk.toString()); });
    proxy.stderr.on("data", (chunk) => { process.stderr.write(chunk.toString()); });
  }

  const throughProxy = await runTurns(origin, turns);
  const overview = await fetchProxyOverview(origin, 10_000);
  const meter = overview ? buildMeter(overview, config) : null;

  const direct = await runTurns(upstream.url, turns);

  const proxyRequests = upstream.bodies;
  const modelCalls = (list) => list.filter((body) => ((body.messages ?? []).length > 0));
  const probeCalls = (list) => list.filter((body) => ((body.messages ?? []).length === 0));
  const proxyModel = modelCalls(proxyRequests);
  const directModel = modelCalls(direct.bodies);
  const report = {
    generatedAt: new Date().toISOString(),
    client: { name: "claude-code", version: await claudeVersion(), model },
    turns,
    coldStartThreshold: threshold,
    provider: { billed: false, note: "local mock upstream — no provider tokens are billed" },
    otherPaths: [...new Set(upstream.otherPaths)],
    throughProxy: {
      modelCalls: proxyModel.length,
      probeCalls: probeCalls(proxyRequests).length,
      cliInvocations: throughProxy.invocations.length,
      cliFailures: throughProxy.failures.length,
      firstRequestBytes: proxyModel[0] ? JSON.stringify(proxyModel[0]).length : null,
      lastRequestBytes: proxyModel.at(-1) ? JSON.stringify(proxyModel.at(-1)).length : null,
      totalRequestBytes: proxyModel.reduce((sum, body) => sum + JSON.stringify(body).length, 0),
      injectedFromCall: proxyModel.findIndex((body) => (body.tools ?? []).length > 0) + 1 || null,
      maxMessages: proxyModel.reduce((max, body) => Math.max(max, (body.messages ?? []).length), 0),
    },
    directBaseline: {
      modelCalls: directModel.length,
      probeCalls: probeCalls(direct.bodies).length,
      cliInvocations: direct.invocations.length,
      cliFailures: direct.failures.length,
      firstRequestBytes: directModel[0] ? JSON.stringify(directModel[0]).length : null,
      lastRequestBytes: directModel.at(-1) ? JSON.stringify(directModel.at(-1)).length : null,
      totalRequestBytes: directModel.reduce((sum, body) => sum + JSON.stringify(body).length, 0),
      maxMessages: directModel.reduce((max, body) => Math.max(max, (body.messages ?? []).length), 0),
    },
    meter: meter
      ? {
          grossSaved: meter.tokens.grossSaved,
          summaryInput: meter.tokens.summaryInput,
          injectedOverhead: meter.tokens.injectedOverhead,
          netAfterOverhead: meter.tokens.netAfterOverhead,
          postFoldRequests: meter.requests.postFold,
          breakEvenPostFoldRequests: meter.requests.breakEvenPostFoldRequests,
        }
      : null,
  };
  report.byteComparison = {
    proxyTotalBytes: report.throughProxy.totalRequestBytes,
    directTotalBytes: report.directBaseline.totalRequestBytes,
    savedBytes: report.directBaseline.totalRequestBytes - report.throughProxy.totalRequestBytes,
    savedPct:
      report.directBaseline.totalRequestBytes > 0
        ? Math.round(((report.directBaseline.totalRequestBytes - report.throughProxy.totalRequestBytes) / report.directBaseline.totalRequestBytes) * 1000) / 10
        : null,
  };

  const jsonFlag = process.argv.indexOf("--json");
  if (jsonFlag >= 0) {
    const out = process.argv[jsonFlag + 1];
    if (!out) throw new Error("--json requires a path");
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (process.env.E2E_DUMP) {
    const dump = join(home, "bodies.json");
    writeFileSync(dump, JSON.stringify({ proxy: proxyModel, direct: directModel }, null, 2));
    console.error(`bodies: ${dump}`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (proxy.exitCode === null) {
    proxy.kill();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  upstream.server.close();
  if (!process.env.E2E_KEEP) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  else console.error(`kept ${home}`);
}

async function runTurns(baseUrl, count) {
  const sessionId = crypto.randomUUID();
  const invocations = [];
  const failures = [];
  const before = upstream.bodies.length;
  // The user's own ~/.claude/settings.json pins ANTHROPIC_BASE_URL, so the run
  // gets its OWN settings file: the client must talk to OUR mock, nothing else.
  const settingsFile = join(home, `settings-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(settingsFile, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: "e2e-local-key",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    },
    includeCoAuthoredBy: false,
  }, null, 2));
  for (let turn = 0; turn < count; turn += 1) {
    const args = [
      "--print",
      "--output-format", "json",
      "--model", model,
      "--dangerously-skip-permissions",
      "--settings", settingsFile,
    ];
    if (turn === 0) args.push("--session-id", sessionId);
    else args.push("--resume", sessionId);
    args.push(`turn ${turn + 1}: summarize the repository layout in one sentence.`);
    const result = await runClaude(args, baseUrl);
    invocations.push(result);
    if (result.code !== 0) failures.push({ turn: turn + 1, code: result.code, stderr: result.stderr.slice(-400) });
  }
  return { invocations, failures, bodies: upstream.bodies.slice(before) };
}

function resolveClaudeBin() {
  if (process.platform !== "win32") return "claude";
  const candidates = [
    join(process.env.APPDATA ?? "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    join(process.env.APPDATA ?? "", "npm", "claude.cmd"),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return "claude";
}

function runClaude(args, baseUrl) {
  return new Promise((resolve) => {
    const child = spawn(claudeBin, args, {
      cwd: workDir,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: "e2e-local-key",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_TELEMETRY: "1",
        DISABLE_AUTOUPDATER: "1",
        IS_SANDBOX: "1",
        HOME: process.env.USERPROFILE ?? process.env.HOME,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function claudeVersion() {
  return new Promise((resolve) => {
    const child = spawn(claudeBin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.on("close", () => resolve(out.trim()));
  });
}

function startMockUpstream() {
  return new Promise((resolve) => {
    const bodies = [];
    const otherPaths = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const path = req.url ?? "";
        if (!path.includes("/v1/messages")) {
          // Not a model call (token count, health, …): answer like a real API
          // would, so the client does not retry against a bogus stream.
          otherPaths.push(path);
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "not_found_error", message: "not found" } }));
          return;
        }
        try {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          bodies.push({});
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_e2e","type":"message","role":"assistant","model":"${model}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":100,"output_tokens":1}}}\n\n`);
        res.write(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`);
        res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n`);
        res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
        res.write(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n`);
        res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, bodies, otherPaths }));
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
