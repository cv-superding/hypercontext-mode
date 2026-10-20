/**
 * Compression-layer A/B with a COOPERATIVE mock model.
 *
 * The stock bench-compression.mjs sends max_tokens:64 on every turn. The proxy
 * classifies max_tokens<=200 as a side request and relays it without touching
 * kernel state, so that benchmark can never observe a fold. This one:
 *
 *   1. sends max_tokens:1024, so every turn is a main request;
 *   2. runs the same growing conversation twice — once with a mock that never
 *      compresses (baseline), once with a mock that calls the real `compress`
 *      tool at FOLD_TURN with a valid mNNNNN range;
 *   3. reports bytes forwarded upstream, the injected fixed cost, the fold
 *      saving, and the net result versus sending the history directly.
 *
 * The mock never calls a real model; it is a protocol-conformant stand-in for
 * a model that cooperates with the injected compression prompt. That isolates
 * "does the plumbing fold and save bytes" from "will a given model choose to".
 *
 *   node tools/bench-compression-coop.mjs [--json docs/bench/compression-coop.json]
 */
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPolicy, getEnginePaths, loadConfig, runtimeEnv } from "@hypercontext/core";

const repoRoot = join(import.meta.dirname, "..");
const bytes = (text) => Buffer.byteLength(text, "utf8");
const TURNS = Number(process.env.COOP_TURNS ?? "30");
const FOLD_TURN = Number(process.env.COOP_FOLD_TURN ?? "20");
const FILLER_REPEAT = Number(process.env.COOP_FILLER_REPEAT ?? "120");
const SUMMARY =
  "Compressed turns 1-17 of the conversation. The user repeatedly asked about the installer writing mcp.json under the state dir and about the proxy keeping folded blocks reversible. " +
  "Each question carried a long filler paragraph arguing that a context window is a budget, not a landfill. The assistant acknowledged every turn. " +
  "Key facts: mcp.json is written under the state dir; blocks are reversible; context is a budget. No errors, decisions, or unresolved questions were recorded.";

function filler(seed) {
  return `[t${seed}] the installer writes mcp.json under the state dir and the proxy keeps blocks reversible; ` +
    "context windows are a budget, not a landfill. ".repeat(FILLER_REPEAT);
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function freePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`no free port near ${start}`);
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function request(port, path, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: body === null ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "mock-key",
          ...headers,
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (chunk) => (out += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
      },
    );
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const response = await request(port, "/__bili/health");
      if (response.status === 200) return true;
    } catch { /* not up yet */ }
  }
  return false;
}

async function runScenario(mode) {
  const home = mkdtempSync(join(tmpdir(), `hctx-coop-${mode}-`));
  const proxyPort = await freePort(17000 + (Date.now() % 8000));
  const mockPort = await freePort(proxyPort + 1);
  const forwarded = [];
  let forwardedCount = 0;

  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      forwarded.push({ body });
      forwardedCount += 1;
      const shouldFold = mode === "compress" && forwardedCount === FOLD_TURN + 1;
      const content = shouldFold
        ? [{
            type: "tool_use",
            id: "toolu_fold_1",
            name: "compress",
            input: {
              content: [{
                startId: "m00001",
                endId: `m${String(2 * (FOLD_TURN - 3)).padStart(5, "0")}`,
                summary: SUMMARY,
                topic: "turns 1-17",
              }],
            },
          }]
        : [{ type: "text", text: "ok" }];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `msg_${forwardedCount}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content,
        stop_reason: shouldFold ? "tool_use" : "end_turn",
        usage: { input_tokens: 100, output_tokens: 2 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(mockPort, "127.0.0.1", resolve));

  const config = { ...loadConfig({ create: false }), compression: { host: "127.0.0.1", port: proxyPort } };
  const policy = buildPolicy({ config });
  const engines = getEnginePaths();
  const env = {
    ...runtimeEnv(policy),
    HYPERCONTEXT_HOME: home,
    // billion-context keeps sessions in XDG_STATE_HOME/billion-context. Without
    // this, a second run resumes the first run's session ids and the "baseline"
    // is no longer a baseline (observed: 2 sessions / 99 requests in one run).
    XDG_STATE_HOME: join(home, "state"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    ACP_UPSTREAM: `http://127.0.0.1:${mockPort}`,
    ACP_PORT: String(mockPort),
    ACP_MODEL_CONTEXT_LIMIT: process.env.BENCH_CONTEXT_LIMIT ?? "200000",
    BILI_AUTO_UPDATE: "0",
    BILI_ADVISORY_CHECK: "false",
    BILI_RELEASE_NOTES_CHECK: "false",
  };
  const child = spawn(process.execPath, [
    engines.billionContext.distEntry, "start", "--port", String(proxyPort), "--host", "127.0.0.1",
  ], { cwd: engines.billionContext.root, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let proxyLog = "";
  child.stderr?.on("data", (chunk) => { proxyLog += chunk.toString(); });

  const healthy = await waitForHealth(proxyPort);
  if (!healthy) {
    killTree(child);
    upstream.close();
    upstream.closeAllConnections?.();
    rmSync(home, { recursive: true, force: true });
    throw new Error(`proxy did not start for ${mode}: ${proxyLog.slice(0, 800)}`);
  }

  const session = `coop-${mode}-${Date.now()}`;
  const turns = [];
  let history = [{ role: "user", content: `hello ${filler(0)}` }];

  const record = async (turn, payload) => {
    const before = forwarded.length;
    const response = await request(proxyPort, "/v1/messages", payload, { "x-acp-session": session });
    const at = forwarded.length - 1;
    const wire = at >= before ? JSON.parse(forwarded[at].body) : null;
    const wireMessages = Array.isArray(wire?.messages) ? wire.messages : [];
    turns.push({
      turn,
      clientBytes: bytes(JSON.stringify(payload.messages)),
      forwardedBytes: at >= before ? bytes(forwarded[at].body) : 0,
      wireMessageCount: wireMessages.length,
      status: response.status,
      responseBody: response.body.slice(0, 2000),
      wirePreview: wireMessages.slice(0, 3).map((message) => JSON.stringify(message).slice(0, 600)),
      wireSystem: (typeof wire?.system === "string" ? wire.system : JSON.stringify(wire?.system ?? "")).slice(0, 800),
      wireRoles: wireMessages.map((message) => message.role),
      wirePrefixes: wireMessages.map((message) =>
        (typeof message.content === "string" ? message.content : JSON.stringify(message.content)).slice(0, 160)),
    });
  };

  await record(0, { model: "claude-sonnet-4-5", max_tokens: 1024, messages: history });

  for (let index = 1; index <= TURNS; index += 1) {
    history = [
      ...history,
      { role: "assistant", content: `reply ${index}` },
      { role: "user", content: `question ${index} ${filler(index)}` },
    ];
    await record(index, { model: "claude-sonnet-4-5", max_tokens: 1024, messages: history });
  }

  const overview = await request(proxyPort, "/__bili/overview");
  killTree(child);
  upstream.close();
  upstream.closeAllConnections?.();
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(home, { recursive: true, force: true });

  const firstWire = JSON.parse(forwarded[0]?.body ?? "{}");
  const systemText = typeof firstWire.system === "string" ? firstWire.system : JSON.stringify(firstWire.system ?? "");
  const overviewJson = (() => { try { return JSON.parse(overview.body); } catch { return { raw: overview.body }; } })();
  const sessionOverview = overviewJson?.overview?.recent?.find((entry) => entry.id === session) ?? null;
  return {
    mode,
    injectedTools: Array.isArray(firstWire.tools) ? firstWire.tools.map((tool) => tool.name) : [],
    systemBytes: bytes(systemText),
    systemMentionsCompress: /compress/i.test(systemText),
    turns,
    proxyOverview: overviewJson,
    sessionOverview,
    proxyLogTail: proxyLog.slice(-1500),
  };
}

const baseline = await runScenario("baseline");
const compressed = await runScenario("compress");

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const directTotal = sum(baseline.turns, "clientBytes");
const baselineTotal = sum(baseline.turns, "forwardedBytes");
const compressedTotal = sum(compressed.turns, "forwardedBytes");
const overheadTotal = baselineTotal - directTotal;
const foldSavings = baselineTotal - compressedTotal;
const netVsDirect = directTotal - compressedTotal;
const postFold = (rows) => rows.filter((row) => row.turn > FOLD_TURN);
const postFoldBaseline = sum(postFold(baseline.turns), "forwardedBytes");
const postFoldCompressed = sum(postFold(compressed.turns), "forwardedBytes");
const foldRow = compressed.turns.find((row) => row.turn === FOLD_TURN);
const postFoldRow = compressed.turns.find((row) => row.turn === FOLD_TURN + 1);
const overview = compressed.sessionOverview ?? {};
const baselineOverview = baseline.sessionOverview ?? {};

const report = {
  generatedAt: new Date().toISOString(),
  config: { turns: TURNS, foldTurn: FOLD_TURN, fillerRepeat: FILLER_REPEAT, maxTokens: 1024 },
  injected: {
    tools: compressed.injectedTools,
    systemBytes: compressed.systemBytes,
    systemMentionsCompress: compressed.systemMentionsCompress,
  },
  baseline: {
    turns: baseline.turns,
    overview: baselineOverview,
    forwardedTotal: baselineTotal,
  },
  compressed: {
    turns: compressed.turns,
    overview,
    forwardedTotal: compressedTotal,
    foldResponse: foldRow?.responseBody ?? null,
    postFoldWirePreview: postFoldRow?.wirePreview ?? null,
  },
  totals: {
    directBytes: directTotal,
    baselineBytes: baselineTotal,
    compressedBytes: compressedTotal,
    proxyOverheadBytes: overheadTotal,
    proxyOverheadPerRequest: Math.round(overheadTotal / baseline.turns.length),
    foldSavingsBytes: foldSavings,
    netVsDirectBytes: netVsDirect,
    postFoldBaselineBytes: postFoldBaseline,
    postFoldCompressedBytes: postFoldCompressed,
    postFoldSavingsBytes: postFoldBaseline - postFoldCompressed,
  },
  verdict: {
    baselineFold: { blocks: baselineOverview.blocks ?? 0, hasFoldData: (baselineOverview.blocks ?? 0) > 0 },
    compressedFold: {
      blocks: overview.blocks ?? 0,
      hasFoldData: (overview.blocks ?? 0) > 0,
      tokensSaved: overview.tokensSaved ?? 0,
      summaryCost: overview.summaryCost ?? 0,
      netSaved: overview.netSaved ?? 0,
      foldCount: overview.foldCount ?? 0,
    },
    foldWorked: (overview.blocks ?? 0) > 0 && (overview.tokensSaved ?? 0) > 0,
    compressionPaysForItself: netVsDirect > 0,
  },
};

if (process.argv.includes("--json")) {
  const out = process.argv[process.argv.indexOf("--json") + 1];
  mkdirSync(join(repoRoot, "docs", "bench"), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
}

const kb = (value) => `${(value / 1024).toFixed(1)} KB`;
console.log(`cooperative compression A/B — ${TURNS} turns, forced fold at turn ${FOLD_TURN}, max_tokens=1024`);
console.log(`injected: ${report.injected.tools.length} tools + ${kb(report.injected.systemBytes)} system prompt`);
console.log("");
console.log("turn  client history  baseline wire  compressed wire  wire msgs (base/comp)");
for (let index = 0; index <= TURNS; index += 1) {
  const base = baseline.turns.find((row) => row.turn === index);
  const comp = compressed.turns.find((row) => row.turn === index);
  if (!base || !comp) continue;
  console.log(
    `${String(index).padStart(4)}  ${kb(base.clientBytes).padStart(14)}  ${kb(base.forwardedBytes).padStart(13)}  ` +
    `${kb(comp.forwardedBytes).padStart(15)}  ${String(base.wireMessageCount).padStart(9)}/${comp.wireMessageCount}`,
  );
}
console.log("");
console.log(`direct client total:        ${kb(directTotal)}`);
console.log(`proxy baseline total:       ${kb(baselineTotal)}  (overhead ${kb(overheadTotal)}, ${kb(overheadTotal / baseline.turns.length)}/request)`);
console.log(`proxy + compression total:  ${kb(compressedTotal)}`);
console.log(`fold saving:                ${kb(foldSavings)}`);
console.log(`net vs direct:              ${kb(netVsDirect)}  (${netVsDirect > 0 ? "saves" : "costs more"})`);
console.log(`post-fold saving:           ${kb(postFoldBaseline - postFoldCompressed)} over ${postFold(compressed.turns).length} turns`);
console.log(`fold: blocks=${overview.blocks ?? 0}, tokensSaved=${overview.tokensSaved ?? 0}, summaryCost=${overview.summaryCost ?? 0}, hasFoldData=${(overview.blocks ?? 0) > 0}`);
if (!report.verdict.foldWorked) console.log(`fold response: ${(foldRow?.responseBody ?? "").slice(0, 500)}`);
