/**
 * Effect benchmark: measures the deterministic, offline-verifiable parts of
 * what HyperContext changes for a model's context window.
 *
 *   node tools/bench-effect.mjs [--json docs/bench/effect.json]
 *
 * Every number here is produced by running the real engines on this machine.
 * Anything that needs live model traffic (the compression proxy's savings) is
 * reported separately by `hctx stats` and is NOT fabricated here.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(import.meta.dirname, "..");
const hctx = join(repoRoot, "bin", "hctx.mjs");
const home = mkdtempSync(join(tmpdir(), "hctx-effect-"));

function runHook(event, input, env = {}) {
  return execFileSync(process.execPath, [hctx, "hook", "claude-code", event], {
    input: JSON.stringify(input),
    env: { ...process.env, HYPERCONTEXT_HOME: home, ...env },
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
  }).toString();
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf-8");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [hctx, "mcp", "--client", "claude-code"],
  env: { ...process.env, HYPERCONTEXT_HOME: home },
  cwd: repoRoot,
  stderr: "pipe",
});
const client = new Client({ name: "hctx-effect", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
const text = (result) => result.content?.[0]?.text ?? "";

// ── 1. session-start injection: unified minimal hint vs full memory block ──
const filler = "决策记录：选择 SQLite FTS5 + porter/trigram 双分词，因为 bm25 排序需要两者并存；".repeat(80);
for (let index = 0; index < 8; index += 1) {
  await client.callTool({ name: "ctx_index", arguments: { content: `${filler} #${index}`, source: `note-${index}.md` } });
}
const sessionInput = { session_id: "effect-bench", hook_event_name: "SessionStart", source: "startup" };
const injectionFull = runHook("sessionstart", sessionInput, { HYPERCONTEXT_MEMORY_INJECTION: "full" });
const injectionMinimal = runHook("sessionstart", sessionInput, { HYPERCONTEXT_MEMORY_INJECTION: "minimal" });

// A fresh session has no memory to inject, so the difference only shows up on
// resume — build real events, compact them into a snapshot, then resume.
for (let index = 0; index < 6; index += 1) {
  runHook("posttooluse", {
    session_id: "effect-bench",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: `npm test #${index}` },
    tool_response: `test run ${index} output\n` + "assertion passed: routing keeps large output out of context; ".repeat(60),
  });
}
runHook("precompact", { session_id: "effect-bench", hook_event_name: "PreCompact" });
const resumeInput = { session_id: "effect-bench", hook_event_name: "SessionStart", source: "resume" };
const resumeFull = runHook("sessionstart", resumeInput, { HYPERCONTEXT_MEMORY_INJECTION: "full" });
const resumeMinimal = runHook("sessionstart", resumeInput, { HYPERCONTEXT_MEMORY_INJECTION: "minimal" });

// ── 2. large Read: what the model is charged for the nudge ──
const fixtureRel = "installer/HyperContextSetup.cs";
const fixturePath = join(repoRoot, fixtureRel);
const fixtureSize = statSync(fixturePath).size;
const guidance = runHook("pretooluse", {
  session_id: "effect-bench",
  tool_name: "Read",
  tool_input: { file_path: fixturePath },
});
const guidanceBytes = byteLength(guidance);

// ── 3. retrieval: exact identifiers vs natural-language questions ──
await client.callTool({ name: "ctx_index", arguments: { content: readFileSync(fixturePath, "utf-8"), source: fixtureRel } });

const EXACT = ["hypercontext-uninstall.bak", "installer.state", "RefreshClientBadges", "EnsureCodexMcp"];
const FUZZY = ["卸载时备份文件叫什么名字", "安装器怎么知道已经装过", "客户端徽标用什么颜色", "谁来负责启动压缩代理"];

async function probe(query) {
  const answer = text(await client.callTool({ name: "ctx_search", arguments: { queries: [query] } }));
  return { query, chars: answer.length, hit: !/No results found/i.test(answer) && answer.length > 200 };
}

const exactResults = [];
for (const query of EXACT) exactResults.push(await probe(query));
const fuzzyResults = [];
for (const query of FUZZY) fuzzyResults.push(await probe(query));

// ── 4. same job two ways: recover N exact identifiers from one large file ──
// Baseline A: the agent reads the whole file into context, once per question.
// Baseline B: the agent reads it once, then greps per question (conservative).
// Sandbox: index once (the ack is the only model-side cost), then ctx_search.
function grepLike(source, term, context = 2) {
  const lines = source.split(/\r?\n/);
  const wanted = new Set();
  lines.forEach((line, index) => {
    if (!line.includes(term)) return;
    for (let offset = -context; offset <= context; offset += 1) {
      if (lines[index + offset] !== undefined) wanted.add(index + offset);
    }
  });
  return [...wanted].sort((a, b) => a - b).map((index) => `${index + 1}: ${lines[index]}`).join("\n");
}

const fixtureSource = readFileSync(fixturePath, "utf-8");
const readOnceBytes = byteLength(fixtureSource);
const grepBytes = EXACT.reduce((total, term) => total + byteLength(grepLike(fixtureSource, term)), 0);
const sandboxBytes = exactResults.reduce((total, row) => total + row.chars, 0);
const indexAckBytes = byteLength(text(await client.callTool({ name: "ctx_index", arguments: { content: "benchmark marker", source: "ack-size-probe" } })));

await client.close();

const report = {
  generatedAt: new Date().toISOString(),
  sessionStartInjection: {
    fullBytes: byteLength(injectionFull),
    minimalBytes: byteLength(injectionMinimal),
    savedBytes: byteLength(injectionFull) - byteLength(injectionMinimal),
  },
  resumeInjection: {
    fullBytes: byteLength(resumeFull),
    minimalBytes: byteLength(resumeMinimal),
    savedBytes: byteLength(resumeFull) - byteLength(resumeMinimal),
  },
  largeRead: {
    fixture: fixtureRel,
    fileBytes: fixtureSize,
    guidanceBytes,
  },
  retrieval: {
    exact: exactResults,
    fuzzy: fuzzyResults,
    exactHits: exactResults.filter((row) => row.hit).length,
    fuzzyHits: fuzzyResults.filter((row) => row.hit).length,
  },
  sameJobTwoWays: {
    identifiers: EXACT.length,
    readFileOnceBytes: readOnceBytes,
    baselineReadEveryTimeBytes: readOnceBytes * EXACT.length,
    baselineReadOncePlusGrepBytes: readOnceBytes + grepBytes,
    sandboxBytes: sandboxBytes + indexAckBytes,
    indexAckBytes,
  },
};

rmSync(home, { recursive: true, force: true });

if (process.argv.includes("--json")) {
  writeFileSync(process.argv[process.argv.indexOf("--json") + 1], JSON.stringify(report, null, 2));
}

const inj = report.sessionStartInjection;
const res = report.resumeInjection;
console.log(`会话启动注入（新会话）：full ${inj.fullBytes} B → minimal ${inj.minimalBytes} B（省 ${inj.savedBytes} B）`);
console.log(`会话恢复注入（有快照）：full ${res.fullBytes} B → minimal ${res.minimalBytes} B（省 ${res.savedBytes} B）`);
console.log(`大文件 Read：${fixtureSize} B 的文件，模型侧引导 ${guidanceBytes} B`);
console.log(`精确标识符检索命中：${report.retrieval.exactHits}/${EXACT.length}`);
console.log(`自然语言提问命中：${report.retrieval.fuzzyHits}/${FUZZY.length}`);
const two = report.sameJobTwoWays;
console.log(`同一件事两种做法（找回 ${two.identifiers} 个确切标识符）：`);
console.log(`  每次都读全文      : ${two.baselineReadEveryTimeBytes} B`);
console.log(`  读一次 + 每次 grep : ${two.baselineReadOncePlusGrepBytes} B`);
console.log(`  沙箱（索引 + 检索）: ${two.sandboxBytes} B`);
console.log("");
for (const row of [...report.retrieval.exact, ...report.retrieval.fuzzy]) {
  console.log(`  ${row.hit ? "命中" : "未中"} ${row.chars} B  ${row.query}`);
}
