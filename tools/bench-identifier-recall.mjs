/**
 * Why do some exact identifiers miss? Compares, per term: presence in the
 * indexed file (ground truth via rg), whole-term retrieval, split-word
 * retrieval, and prefix retrieval.
 *
 *   node tools/bench-identifier-recall.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "hctx-recall-"));

const FILES = [
  "packages/core/src/federation.ts",
  "packages/core/src/policy.ts",
  "packages/core/src/paths.ts",
  "packages/runtime/src/uninstall.ts",
  "packages/runtime/src/setup.ts",
  "packages/runtime/src/engines.ts",
];

const TERMS = [
  { term: "federatedSearch", file: "packages/core/src/federation.ts", hitBefore: false },
  { term: "buildPolicy", file: "packages/core/src/policy.ts", hitBefore: false },
  { term: "getHypercontextPaths", file: "packages/core/src/paths.ts", hitBefore: false },
  { term: "planUninstall", file: "packages/runtime/src/uninstall.ts", hitBefore: false },
  { term: "resolveWorkspaceDir", file: "packages/runtime/src/engines.ts", hitBefore: true },
  { term: "isHypercontextHookEntry", file: "packages/runtime/src/setup.ts", hitBefore: true },
  { term: "stripCodexBlock", file: "packages/runtime/src/uninstall.ts", hitBefore: true },
  { term: "hashProjectDir", file: "packages/core/src/federation.ts", hitBefore: true },
];

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
const client = new Client({ name: "hctx-recall", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
const text = (r) => r.content?.[0]?.text ?? "";

for (const file of FILES) {
  await client.callTool({ name: "ctx_index", arguments: { path: join(repoRoot, file), source: file } });
}

function exists(term, file) {
  try {
    execFileSync("rg", ["-c", "--", term, file], { cwd: repoRoot, encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

async function retrieve(query) {
  const answer = text(await client.callTool({ name: "ctx_search", arguments: { queries: [query], limit: 5 } }));
  return { found: !/No results found/i.test(answer) && answer.length > 260, bytes: answer.length };
}

const split = (term) => term.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

console.log("术语                       在文件里  整词检索  拆词检索  前缀检索   之前判为");
for (const item of TERMS) {
  const whole = await retrieve(item.term);
  const words = await retrieve(split(item.term));
  const prefix = await retrieve(item.term.slice(0, Math.max(6, Math.floor(item.term.length / 2))));
  console.log(
    `${item.term.padEnd(26)}  ${exists(item.term, item.file) ? "  是  " : "  否  "}  ${whole.found ? " 命中 " : " 未中 "}  ${words.found ? " 命中 " : " 未中 "}  ${prefix.found ? " 命中 " : " 未中 "}   ${item.hitBefore ? "命中" : "未命中"}`,
  );
}

await client.close();
rmSync(home, { recursive: true, force: true });
