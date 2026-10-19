/**
 * Retrieval scale + query-shape test.
 *
 * Deliberately batches each probe set into ONE ctx_search call: ctx_search is
 * throttled per rolling window ("call #N/8 … results limited … block after"), so
 * sequential single-query probes measure the throttle, not recall. Any row whose
 * answer contains the throttle marker is reported as throttled, never as a miss.
 *
 *   node tools/bench-scale.mjs [--json docs/bench/scale.json]
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "hctx-scale-"));
const kb = (n) => Math.round(n / 1024);
// The footer always prints "Throttle: call #N/8"; only these two mean results were actually degraded.
const NOTICE = /Throttle: call #/i;
const THROTTLED = /Results limited to \d+\/query|before block|blocked after/i;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repoRoot, "bin", "hctx.mjs"), "mcp", "--client", "claude-code"],
  env: { ...process.env, HYPERCONTEXT_HOME: home },
  cwd: repoRoot,
  stderr: "pipe",
});
const client = new Client({ name: "hctx-scale", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
const text = (result) => result.content?.[0]?.text ?? "";

const needle = (index) => `MarkerToken${index}UniqueNeedle`;

async function probe(queries, limit) {
  const started = performance.now();
  const answer = text(await client.callTool({ name: "ctx_search", arguments: { queries, limit } }));
  const elapsed = performance.now() - started;
  // ctx_search echoes the query text even when it found nothing, so "answer
  // contains query" is NOT a hit. Split per "## <query>" section and require the
  // section to carry a real result.
  const sections = answer.split(/^## /m).slice(1);
  let hits = 0;
  for (const query of queries) {
    const section = sections.find((part) => part.trim().toLowerCase().startsWith(query.trim().toLowerCase()));
    if (!section) continue;
    if (/No results found/i.test(section)) continue;
    const body = section.slice(section.indexOf("\n") + 1).replace(/\s+/g, "");
    if (body.length >= 80) hits += 1;
  }
  return {
    elapsedMs: Math.round(elapsed),
    bytes: answer.length,
    hits,
    total: queries.length,
    sections: sections.length,
    throttled: THROTTLED.test(answer),
    throttleNotice: NOTICE.test(answer),
  };
}

const STEPS = [1, 10, 50, 150];
const rows = [];
let indexed = 0;

for (const target of STEPS) {
  while (indexed < target) {
    const body = `# note ${indexed}\n\nThe constant ${needle(indexed)} is defined here and nowhere else.\n\n` + "Sentence about chunking, bm25 ranking and trigram matching for realistic prose weight. ".repeat(14);
    await client.callTool({ name: "ctx_index", arguments: { content: body, source: `note-${indexed}` } });
    indexed += 1;
  }

  const probes = [target - 1, Math.floor(target / 2), 0];
  const result = await probe(probes.map(needle), 10);

  let dbBytes = 0;
  const contentDir = join(home, "data", "context-mode", "content");
  mkdirSync(contentDir, { recursive: true });
  for (const entry of readdirSync(contentDir)) {
    if (entry.endsWith(".db")) dbBytes += statSync(join(contentDir, entry)).size;
  }

  rows.push({ sources: target, ...result, contentDbKb: kb(dbBytes) });
}

// Same corpus size, two query shapes: exact identifiers vs natural language.
const exact = await probe([needle(149), needle(75), needle(0), needle(30)], 10);
const fuzzy = await probe(
  ["这个常量定义在哪里", "哪份笔记提到分词与排序", "找出唯一的标识符", "句子权重是怎么写的"],
  10,
);

await client.close();

const report = { generatedAt: new Date().toISOString(), steps: rows, at150Sources: { exactIdentifiers: exact, naturalLanguage: fuzzy } };
if (process.argv.includes("--json")) {
  writeFileSync(process.argv[process.argv.indexOf("--json") + 1], JSON.stringify(report, null, 2));
}

console.log("源数  精确标识符命中  平均单次延迟  内容库   被限流");
for (const row of rows) {
  console.log(`${String(row.sources).padStart(4)}  ${(row.hits + "/" + row.total).padStart(7)}  ${(row.elapsedMs + "ms").padStart(10)}  ${(row.contentDbKb + " KB").padStart(7)}  ${row.throttled ? "是" : "否"}`);
}
console.log("");
console.log(`150 源 · 精确标识符一次批量查：${exact.hits}/${exact.total}（${exact.bytes} B，节流=${exact.throttled ? "是" : "否"}）`);
console.log(`150 源 · 自然语言一次批量查：  ${fuzzy.hits}/${fuzzy.total}（${fuzzy.bytes} B，节流=${fuzzy.throttled ? "是" : "否"}）`);

rmSync(home, { recursive: true, force: true });
