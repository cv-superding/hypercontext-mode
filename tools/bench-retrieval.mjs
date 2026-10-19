/**
 * Head-to-head: sandbox retrieval vs ripgrep, on this repository's own files.
 *
 * Three query classes with known ground truth, scored identically for both
 * sides. Bytes = what would land in the model's context.
 *
 *   node tools/bench-retrieval.mjs [--json docs/bench/retrieval.json]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "hctx-retr-"));
const bytes = (text) => Buffer.byteLength(text, "utf8");

/** Corpus + ground truth. `answer` is a file that mentions it; `definition` is
 *  the exact source line where it is declared, auto-extracted with rg so both
 *  sides are scored with the same yardstick. */
const CASES = {
  exact: [
    { query: "resolveWorkspaceDir", answer: "engines.ts" },
    { query: "federatedSearch", answer: "federation.ts" },
    { query: "isHypercontextHookEntry", answer: "setup.ts" },
    { query: "stripCodexBlock", answer: "uninstall.ts" },
    { query: "EnsureCodexMcp", answer: "HyperContextSetup.cs" },
    { query: "RefreshInstallStateUi", answer: "HyperContextSetup.cs" },
    { query: "buildPolicy", answer: "policy.ts" },
    { query: "hashProjectDir", answer: "federation.ts" },
    { query: "getHypercontextPaths", answer: "paths.ts" },
    { query: "planUninstall", answer: "uninstall.ts" },
  ],
  stem: [
    { query: "chunking", answer: "truncate.ts" },
    { query: "ranking", answer: "routing.mjs" },
    { query: "indexing", answer: "store.ts" },
    { query: "compaction", answer: "precompact.mjs" },
    { query: "throttling", answer: "runPool.ts" },
    { query: "caching", answer: "fetch-cache.ts" },
  ],
  prose: [
    { query: "how does the installer remember a previous install", answer: "HyperContextSetup.cs" },
    { query: "where is the memory injection mode decided", answer: "routing.mjs" },
    { query: "which file decides the unified MCP tool surface", answer: "mcp.ts" },
    { query: "what keeps the two engines from double compacting", answer: "policy.ts" },
  ],
};

const FILES = [
  "packages/runtime/src/engines.ts",
  "packages/runtime/src/mcp.ts",
  "packages/runtime/src/setup.ts",
  "packages/runtime/src/uninstall.ts",
  "packages/core/src/federation.ts",
  "packages/core/src/paths.ts",
  "packages/core/src/policy.ts",
  "packages/cli/src/main.ts",
  "installer/HyperContextSetup.cs",
  "engines/context-mode/hooks/core/routing.mjs",
  "engines/context-mode/hooks/sessionstart.mjs",
  "engines/context-mode/hooks/precompact.mjs",
  "engines/context-mode/src/truncate.ts",
  "engines/context-mode/src/store.ts",
  "engines/context-mode/src/runPool.ts",
  "engines/context-mode/src/fetch-cache.ts",
];

/**
 * Shared yardstick. Three increasingly strict notions of "hit", scored
 * identically for ripgrep and for the sandbox:
 *   term  – the queried string appears in what came back
 *   def   – the declaration line itself came back (auto-extracted with rg below)
 *   file  – the file known to define it is named in the output
 */
function definitionLine(term) {
  for (const pattern of [`function ${term}`, `const ${term}`, `class ${term}`, `${term}\\s*[=(]`]) {
    try {
      const out = execFileSync("rg", ["-n", "--no-heading", "-e", pattern, ...FILES], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
      const line = out.split("\n").find(Boolean);
      if (!line) continue;
      const parts = line.split(":");
      const code = parts.slice(2).join(":").trim();
      if (code.length >= 12) return code.slice(0, 60);
    } catch { /* try next pattern */ }
  }
  return "";
}

function scoreOutput(output, item) {
  return {
    term: output.includes(item.query),
    def: item.definition ? output.includes(item.definition) : false,
    file: output.includes(item.answer),
  };
}

for (const key of ["exact", "stem", "prose"]) {
  for (const item of CASES[key]) item.definition = definitionLine(item.query);
}

// ── ripgrep side ────────────────────────────────────────────────────────────
function rg(classification) {
  const score = { term: 0, def: 0, file: 0 };
  let totalBytes = 0;
  let calls = 0;
  const misses = [];
  for (const item of CASES[classification]) {
    calls += 1;
    let out = "";
    try {
      out = execFileSync("rg", ["-n", "--max-count", "3", "-C", "1", "--", item.query, ...FILES], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      out = "";
    }
    totalBytes += bytes(out);
    const hit = scoreOutput(out, item);
    for (const metric of ["term", "def", "file"]) if (hit[metric]) score[metric] += 1;
    if (!hit.file) misses.push(item.query);
  }
  return { ...score, total: CASES[classification].length, bytes: totalBytes, calls, misses };
}

// ── sandbox side ────────────────────────────────────────────────────────────
// The search throttle (taper after 3 calls, block after 8, 60s window) measures
// call discipline, not recall, so the head-to-head runs with it lifted.
// Production defaults are untouched; the throttle itself is measured separately.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repoRoot, "bin", "hctx.mjs"), "mcp", "--client", "claude-code"],
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
const client = new Client({ name: "hctx-retr", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
const text = (result) => result.content?.[0]?.text ?? "";

for (const file of FILES) {
  await client.callTool({ name: "ctx_index", arguments: { path: join(repoRoot, file), source: file } });
}

function scoreSandbox(answer, classification) {
  const queries = CASES[classification].map((item) => item.query);
  const sections = answer.split(/^## /m).slice(1);
  const score = { term: 0, def: 0, file: 0 };
  const misses = [];
  for (const item of CASES[classification]) {
    const section = sections.find((part) => part.trim().toLowerCase().startsWith(item.query.trim().toLowerCase()));
    if (!section || /No results found/i.test(section)) {
      misses.push(item.query);
      continue;
    }
    const hit = scoreOutput(section, item);
    for (const metric of ["term", "def", "file"]) if (hit[metric]) score[metric] += 1;
    if (!hit.file) misses.push(item.query);
  }
  return { ...score, total: queries.length, bytes: bytes(answer), calls: 1, misses, sections: sections.length };
}

const sandbox = {};
for (const classification of ["exact", "stem", "prose"]) {
  const queries = CASES[classification].map((item) => item.query);
  const answer = text(await client.callTool({ name: "ctx_search", arguments: { queries, limit: 3 } }));
  sandbox[classification] = scoreSandbox(answer, classification);
}

// Fairness sweep: the byte gap depends on the per-query result budget, so show it.
const sweep = [];
for (const limit of [1, 3, 5]) {
  const queries = CASES.exact.map((item) => item.query);
  const answer = text(await client.callTool({ name: "ctx_search", arguments: { queries, limit } }));
  const scored = scoreSandbox(answer, "exact");
  sweep.push({ limit, term: `${scored.term}/${scored.total}`, def: `${scored.def}/${scored.total}`, file: `${scored.file}/${scored.total}`, bytes: scored.bytes });
}
await client.close();
rmSync(home, { recursive: true, force: true });

const corpusBytes = FILES.reduce((sum, file) => sum + bytes(readFileSync(join(repoRoot, file), "utf8")), 0);
const report = {
  generatedAt: new Date().toISOString(),
  corpusFiles: FILES.length,
  corpusBytes,
  fullReadBytes: corpusBytes,
  limitSweep: sweep,
  classes: Object.fromEntries(
    ["exact", "stem", "prose"].map((key) => [key, { rg: rg(key), sandbox: sandbox[key] }]),
  ),
};

if (process.argv.includes("--json")) {
  writeFileSync(process.argv[process.argv.indexOf("--json") + 1], JSON.stringify(report, null, 2));
}

const label = { exact: "精确标识符", stem: "词形变化(词干)", prose: "自然语言" };
console.log(`语料：${FILES.length} 个真实文件，共 ${Math.round(corpusBytes / 1024)} KB（全文读进上下文就是这个数）`);
console.log("");
console.log("查询类型          ripgrep(逐条)                                    沙箱(一次批量)");
for (const key of ["exact", "stem", "prose"]) {
  const r = report.classes[key].rg;
  const s = report.classes[key].sandbox;
  console.log(
    `${label[key].padEnd(12)}  术语 ${(r.term+"/"+r.total).padStart(5)}  定义行 ${(r.def+"/"+r.total).padStart(5)}  定义文件 ${(r.file+"/"+r.total).padStart(5)}  ${String(r.bytes).padStart(6)} B ${String(r.calls+" 次").padStart(5)} 次  |  术语 ${(s.term+"/"+s.total).padStart(5)}  定义行 ${(s.def+"/"+s.total).padStart(5)}  定义文件 ${(s.file+"/"+s.total).padStart(5)}  ${String(s.bytes).padStart(6)} B ${s.calls} 次`,
  );
}
console.log("");
console.log(`沙箱 limit 扫描（精确标识符 10 问一次批量）：`);
for (const row of sweep) console.log(`   limit=${row.limit} → 术语 ${row.term} / 定义行 ${row.def} / 定义文件 ${row.file}，${row.bytes} B`);
console.log("");
for (const key of ["exact", "stem", "prose"]) {
  const r = report.classes[key].rg;
  const s = report.classes[key].sandbox;
  if (r.misses.length) console.log(`  ripgrep 未命中(${key})：${r.misses.join(", ")}`);
  if (s.misses.length) console.log(`  沙箱未命中(${key})：${s.misses.join(", ")}`);
}
