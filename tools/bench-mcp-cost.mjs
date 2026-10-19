/**
 * Fixed context cost of installing HyperContext.
 *
 * Answers "what does a brand-new window pay?" — the MCP tool surface (full
 * schema vs names-only lazy listing) and the session-start hook injection.
 *
 *   node tools/bench-mcp-cost.mjs [--json docs/bench/mcp-cost.json]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(import.meta.dirname, "..");
const home = mkdtempSync(join(tmpdir(), "hctx-cost-"));
const bytes = (text) => Buffer.byteLength(text, "utf-8");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repoRoot, "bin", "hctx.mjs"), "mcp", "--client", "claude-code"],
  env: { ...process.env, HYPERCONTEXT_HOME: home },
  cwd: repoRoot,
  stderr: "pipe",
});
const client = new Client({ name: "hctx-cost", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const listed = await client.listTools();
const tools = listed.tools.map((tool) => {
  const description = tool.description ?? "";
  const schema = JSON.stringify(tool.inputSchema ?? {});
  return { name: tool.name, descriptionBytes: bytes(description), schemaBytes: bytes(schema), totalBytes: bytes(description) + bytes(schema) };
});
const instructions = listed.instructions ?? "";

const fullSurface = tools.reduce((sum, tool) => sum + tool.totalBytes, 0) + bytes(instructions);
const namesOnly = tools.map((tool) => `mcp__hypercontext__${tool.name}`).join(", ");
const serverBlock = JSON.stringify({ mcpServers: { hypercontext: { command: "node", args: ["bin/hctx.mjs", "mcp"] } } }, null, 2);

// Session-start injection is what a hooks-enabled client pays on every new window.
const sessionStart = execFileSync(process.execPath, [join(repoRoot, "bin", "hctx.mjs"), "hook", "claude-code", "sessionstart"], {
  input: JSON.stringify({ session_id: "cost-bench", hook_event_name: "SessionStart", source: "startup" }),
  env: { ...process.env, HYPERCONTEXT_HOME: home },
  cwd: repoRoot,
}).toString();

await client.close();
rmSync(home, { recursive: true, force: true });

const report = {
  generatedAt: new Date().toISOString(),
  toolCount: tools.length,
  perTool: tools.sort((a, b) => b.totalBytes - a.totalBytes),
  instructionsBytes: bytes(instructions),
  fullSurfaceBytes: fullSurface,
  namesOnlyListingBytes: bytes(namesOnly),
  sessionStartInjectionBytes: bytes(sessionStart),
  mcpConfigBlockBytes: bytes(serverBlock),
};

if (process.argv.includes("--json")) {
  writeFileSync(process.argv[process.argv.indexOf("--json") + 1], JSON.stringify(report, null, 2));
}

console.log(`工具数 ${report.toolCount}，完整 schema+描述合计 ${report.fullSurfaceBytes} B（含 instructions ${report.instructionsBytes} B）`);
console.log(`懒加载宿主只注入名字清单：${report.namesOnlyListingBytes} B`);
console.log(`会话启动注入（claude-code hooks）：${report.sessionStartInjectionBytes} B / 新窗口`);
console.log("");
console.log("最贵的 5 个工具描述：");
for (const tool of report.perTool.slice(0, 5)) {
  console.log(`  ${String(tool.totalBytes).padStart(6)} B  ${tool.name}  (描述 ${tool.descriptionBytes} B / schema ${tool.schemaBytes} B)`);
}
