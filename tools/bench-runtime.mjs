/**
 * Runtime evidence: the "think-in-code" claim measured directly, plus SQLite
 * concurrency and crash recovery. Everything runs against a throwaway
 * HYPERCONTEXT_HOME so a live install is never touched.
 *
 *   node tools/bench-runtime.mjs [--json docs/bench/runtime.json]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { kill } from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(import.meta.dirname, "..");
const hctx = join(repoRoot, "bin", "hctx.mjs");
const bytes = (text) => Buffer.byteLength(text, "utf8");
const text = (result) => result.content?.[0]?.text ?? "";

function connect(home, name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [hctx, "mcp", "--client", "claude-code"],
    env: {
      ...process.env,
      HYPERCONTEXT_HOME: home,
      CONTEXT_MODE_PROJECT_DIR: repoRoot,
      CONTEXT_MODE_SEARCH_WINDOW_MS: "1",
      CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER: "100000",
      CONTEXT_MODE_SEARCH_BLOCK_AFTER: "100000",
    },
    cwd: repoRoot,
    stderr: "pipe",
  });
  return { transport, client: new Client({ name, version: "0.0.0" }, { capabilities: {} }) };
}

async function connected(home, name) {
  const pair = connect(home, name);
  await pair.client.connect(pair.transport);
  return pair.client;
}

// ── 1. think-in-code: same 200 KB log, four ways to handle it ───────────────
const home1 = mkdtempSync(join(tmpdir(), "hctx-big-"));
const main = await connected(home1, "big");

const GENERATOR = `
const lines = [];
for (let i = 0; i < 2000; i++) lines.push(\`2026-10-19T12:00:\${String(i % 60).padStart(2, "0")}Z INFO worker-\${i % 8} processed request \${i} in \${(i % 97) + 1}ms\`);
lines[412] = lines[412].replace("INFO", "ERROR");
lines[907] = lines[907].replace("INFO", "ERROR");
lines[1888] = lines[1888].replace("INFO", "ERROR");
globalThis.__LOG = lines.join("\\n");
`;

const rawSize = Number(execFileSync(process.execPath, ["-e", `${GENERATOR}; process.stdout.write(String(Buffer.byteLength(globalThis.__LOG)))`], { encoding: "utf8" }));

const deriveOnly = text(await main.callTool({
  name: "ctx_execute",
  arguments: {
    language: "javascript",
    code: `${GENERATOR}; const e = globalThis.__LOG.split("\\n").filter(l => l.includes("ERROR")); console.log(\`errors: \${e.length}\`); console.log(e.join("\\n"));`,
  },
}));
const batched = text(await main.callTool({
  name: "ctx_batch_execute",
  arguments: {
    commands: [{ label: "build log", command: `node -e "${GENERATOR.replace(/\n/g, " ").replace(/"/g, "\\\"")}; console.log(globalThis.__LOG)"` }],
    queries: ["ERROR lines in the build log"],
  },
}));

// Passthrough proof: whatever you print comes back verbatim, so the savings are
// entirely a function of what you choose to print.
const NL = String.fromCharCode(10);
const passthrough = [];
for (const [label, count] of [["≈2.7KB", 40], ["≈27KB", 400], ["≈80KB", 1200]]) {
  const code = [
    "const lines = [];",
    `for (let i = 0; i < ${count}; i++) lines.push("LINE" + i + " " + "x".repeat(60));`,
    `console.log(lines.join(${JSON.stringify(NL)}));`,
  ].join(NL);
  const result = await main.callTool({ name: "ctx_execute", arguments: { language: "javascript", code } });
  const out = text(result);
  passthrough.push({
    label,
    expectedBytes: count * 67,
    returnedBytes: bytes(out),
    lastLinePresent: out.includes(`LINE${count - 1}`),
    truncationNotice: /truncat|omitted|\[\.\.\.\]/i.test(out),
  });
}

const bigOutput = {
  rawLogBytes: rawSize,
  derivedAnswer: bytes(deriveOnly),
  batchExecute: bytes(batched),
  derivedContainsErrors: deriveOnly.includes("errors: 3"),
  batchContainsErrors: batched.includes("ERROR"),
  passthrough,
};

// ── 2. concurrency: 4 clients writing to one SQLite store ───────────────────
const home2 = mkdtempSync(join(tmpdir(), "hctx-conc-"));
const writers = [];
for (let index = 0; index < 4; index += 1) writers.push(await connected(home2, `w${index}`));
const perWriter = 25;
const started = performance.now();
let errors = 0;
await Promise.all(
  writers.map(async (writer, index) => {
    for (let n = 0; n < perWriter; n += 1) {
      try {
        await writer.callTool({
          name: "ctx_index",
          arguments: { content: `# concurrent ${index}-${n}\n\nToken C${index}N${n} written by writer ${index}.`, source: `conc-${index}-${n}` },
        });
      } catch {
        errors += 1;
      }
    }
  }),
);
const writeMs = Math.round(performance.now() - started);
const verify = text(await writers[0].callTool({
  name: "ctx_search",
  arguments: { queries: ["C0N7", "C1N13", "C2N19", "C3N24"], limit: 3 },
}));
const concurrency = {
  writers: writers.length,
  writesPerWriter: perWriter,
  attempted: writers.length * perWriter,
  errors,
  wallMs: writeMs,
  spotChecksFound: ["C0N7", "C1N13", "C2N19", "C3N24"].filter((token) => verify.includes(token)).length,
  spotChecksTotal: 4,
};
for (const writer of writers) await writer.close();
rmSync(home2, { recursive: true, force: true });

// ── 3. crash recovery: kill -9 the proxy, then check status and restart ─────
const home3 = mkdtempSync(join(tmpdir(), "hctx-crash-"));
const run = (args) => execFileSync(process.execPath, [hctx, ...args], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, HYPERCONTEXT_HOME: home3, CONTEXT_MODE_PROJECT_DIR: repoRoot },
});
run(["init"]);
run(["start"]);
const statePath = join(home3, "state", "daemon.json");
const pid = JSON.parse(readFileSync(statePath, "utf8")).pid;
kill(pid, "SIGKILL");
await new Promise((resolve) => setTimeout(resolve, 1200));
const afterKill = run(["status"]);
const restarted = run(["start", "--restart"]);
const afterRestart = run(["status"]);
const crash = {
  killedPid: pid,
  detectedStale: /stale/i.test(afterKill),
  reportedNotRunning: /not running/i.test(afterKill),
  restartRecovered: /healthy/i.test(afterRestart),
};
try {
  const live = JSON.parse(readFileSync(statePath, "utf8"));
  if (live.pid) {
    try { kill(live.pid, "SIGTERM"); } catch { /* already gone */ }
  }
} catch { /* no state */ }
run(["stop"]);
rmSync(home3, { recursive: true, force: true });
await main.close();
rmSync(home1, { recursive: true, force: true });

const report = { generatedAt: new Date().toISOString(), bigOutput, concurrency, crash };
if (process.argv.includes("--json")) {
  writeFileSync(process.argv[process.argv.indexOf("--json") + 1], JSON.stringify(report, null, 2));
}

console.log("【大输出四做法】原始日志", rawSize, "B");
for (const row of bigOutput.passthrough) {
  console.log(`  原样回显 ${row.label}：期望 ${row.expectedBytes} B → 返回 ${row.returnedBytes} B，末行在=${row.lastLinePresent}，截断提示=${row.truncationNotice}`);
}
console.log(`  只取派生结论 ctx_execute    ${bigOutput.derivedAnswer} B  省 ${Math.round((1 - bigOutput.derivedAnswer / rawSize) * 100)}%  含正确答案=${bigOutput.derivedContainsErrors}`);
console.log(`  ctx_batch_execute + queries ${bigOutput.batchExecute} B  含 ERROR=${bigOutput.batchContainsErrors}`);
console.log("");
console.log("【并发写】", JSON.stringify(concurrency));
console.log("");
console.log("【杀进程恢复】", JSON.stringify(crash));
