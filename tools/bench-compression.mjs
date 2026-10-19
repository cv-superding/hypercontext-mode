/**
 * Compression-layer pipeline measurement against the real shipped artifact.
 *
 * Spawns the built billion-context proxy exactly like `hctx start` does, but
 * with ACP_UPSTREAM pointed at a local mock that records every byte forwarded
 * to it. Growing a conversation over 8 turns then answers the only question that
 * matters here: does the proxy shrink what reaches the model, and by how much?
 *
 *   node tools/bench-compression.mjs [--json docs/bench/compression.json]
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPolicy, getEnginePaths, loadConfig, runtimeEnv } from "@hypercontext/core";

const repoRoot = join(import.meta.dirname, "..");
const bytes = (text) => Buffer.byteLength(text, "utf8");
const home = mkdtempSync(join(tmpdir(), "hctx-comp-"));
const PROXY_PORT = 8931;
const MOCK_PORT = 8932;

function filler(seed, repeat) {
  return `[t${seed}] the installer writes mcp.json under the state dir and the proxy keeps blocks reversible; ` + "context windows are a budget, not a landfill. ".repeat(repeat);
}

// ── mock upstream: records what the proxy actually forwards ─────────────────
const forwarded = [];
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    forwarded.push({ path: req.url ?? "", body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `msg_${forwarded.length}`,
      type: "message",
      role: "assistant",
      model: "mock",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 2 },
    }));
  });
});
await new Promise((resolve) => upstream.listen(MOCK_PORT, "127.0.0.1", resolve));

// ── the real proxy, same args as the daemon uses ────────────────────────────
const config = { ...loadConfig({ create: false }), compression: { host: "127.0.0.1", port: PROXY_PORT } };
const policy = buildPolicy({ config });
const engines = getEnginePaths();
const env = {
  ...runtimeEnv(policy),
  HYPERCONTEXT_HOME: home,
  ACP_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
  ACP_PORT: String(MOCK_PORT),
  // Injection is gated on context pressure (growth-based nudge), so shrink the
  // declared model window until an 8-turn replay actually crosses the threshold.
  ACP_MODEL_CONTEXT_LIMIT: process.env.BENCH_CONTEXT_LIMIT ?? "200000",
  BILI_AUTO_UPDATE: "0",
  BILI_ADVISORY_CHECK: "false",
  BILI_RELEASE_NOTES_CHECK: "false",
};
const child = spawn(process.execPath, [
  engines.billionContext.distEntry, "start", "--port", String(PROXY_PORT), "--host", "127.0.0.1",
], { cwd: engines.billionContext.root, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let proxyLog = "";
child.stderr?.on("data", (chunk) => { proxyLog += chunk.toString(); });

function request(path, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PROXY_PORT,
        path,
        method: body === null ? "GET" : "POST",
        headers: { "content-type": "application/json", "x-api-key": "mock-key", ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
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

// wait for health
let healthy = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    healthy = await request("/__bili/health", undefined);
    if (healthy.status === 200) break;
  } catch { /* not up yet */ }
}
if (!healthy || healthy.status !== 200) {
  console.error("代理没起来：", proxyLog.slice(0, 800));
  child.kill("SIGTERM");
  upstream.close();
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
}

// ── discovery: what lands on the wire for a plain request ───────────────────
let history = [{ role: "user", content: `hello ${filler(0, 2)}` }];
await request("/v1/messages", { model: "claude-sonnet-4-5", max_tokens: 64, messages: history }, { "x-acp-session": "bench-conv" });
const firstWire = JSON.parse(forwarded[0]?.body ?? "{}");
const injectedTools = Array.isArray(firstWire.tools) ? firstWire.tools.map((tool) => tool.name) : [];
const systemText = typeof firstWire.system === "string" ? firstWire.system : JSON.stringify(firstWire.system ?? "");

// ── growth replay: 8 turns ──────────────────────────────────────────────────
const turns = [];
for (let index = 1; index <= 8; index += 1) {
  history = [
    ...history,
    { role: "assistant", content: `reply ${index}` },
    { role: "user", content: `question ${index} ${filler(index, 30)}` },
  ];
  const before = forwarded.length;
  const response = await request("/v1/messages", { model: "claude-sonnet-4-5", max_tokens: 64, messages: history }, { "x-acp-session": "bench-conv" });
  const at = forwarded.length - 1;
  const wire = at >= before ? JSON.parse(forwarded[at].body) : null;
  const wireMessages = Array.isArray(wire?.messages) ? wire.messages : [];
  turns.push({
    turn: index,
    clientBytes: bytes(JSON.stringify(history)),
    forwardedBytes: at >= before ? bytes(forwarded[at].body) : 0,
    wireMessageCount: wireMessages.length,
    status: response.status,
  });
}

const overview = await request("/__bili/overview", undefined);
child.kill("SIGTERM");
upstream.close();
await new Promise((resolve) => setTimeout(resolve, 300));
rmSync(home, { recursive: true, force: true });

const first = turns[0];
const last = turns[turns.length - 1];
const ratio = first.forwardedBytes > 0 ? last.forwardedBytes / first.forwardedBytes : 0;
const rewritten = turns.some((row, index) => index > 0 && row.wireMessageCount < turns[index - 1].wireMessageCount);

const report = {
  generatedAt: new Date().toISOString(),
  proxy: "engines/billion-context/dist/index.js",
  injectedTools,
  systemBytes: bytes(systemText),
  mentionsCompress: /compress/i.test(systemText),
  turns,
  forwardedGrowthRatio: Number(ratio.toFixed(2)),
  clientGrowthRatio: Number((last.clientBytes / first.clientBytes).toFixed(2)),
  historyRewritten: rewritten,
  proxyOverview: (() => { try { return JSON.parse(overview.body); } catch { return overview.body; } })(),
};

if (process.argv.includes("--json")) {
  mkdirSync(join(repoRoot, "docs", "bench"), { recursive: true });
  writeFileSync(process.argv[process.argv.indexOf("--json") + 1], JSON.stringify(report, null, 2));
}

console.log(`代理注入工具：${injectedTools.join(", ") || "（无）"}；system ${report.systemBytes} B，提到压缩=${report.mentionsCompress}`);
console.log("");
console.log("轮次  客户端历史字节  转发给上游字节  线上消息数");
for (const row of turns) console.log(`${String(row.turn).padStart(3)}  ${String(row.clientBytes).padStart(14)}  ${String(row.forwardedBytes).padStart(14)}  ${String(row.wireMessageCount).padStart(10)}`);
console.log("");
console.log(`增长：客户端 ${(last.clientBytes / first.clientBytes).toFixed(1)}×，转发 ${ratio.toFixed(1)}×，检测到历史被改写=${rewritten}`);
console.log(`代理自报 overview：${JSON.stringify(report.proxyOverview).slice(0, 300)}`);
