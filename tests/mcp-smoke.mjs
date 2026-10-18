import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = process.env.HYPERCONTEXT_HOME;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../bin/hctx.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "mcp", "--client", "claude-code"],
  env: { ...process.env, HYPERCONTEXT_HOME: home },
  cwd: process.cwd(),
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(`[child] ${chunk}`));
const client = new Client({ name: "hctx-smoke", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
const tools = await client.listTools();
console.log("TOOLS", tools.tools.map((tool) => tool.name).join(","));
const status = await client.callTool({ name: "hc_status", arguments: {} });
console.log("STATUS");
console.log(status.content?.[0]?.text ?? "");
const search = await client.callTool({ name: "hc_search", arguments: { query: "needle-llm" } });
console.log("SEARCH");
console.log(search.content?.[0]?.text ?? "");
const ctx = await client.callTool({ name: "ctx_search", arguments: { queries: ["needle-llm"] } });
console.log("CTX_SEARCH", ctx.isError === true ? "ERROR" : "OK");
console.log((ctx.content?.[0]?.text ?? "").slice(0, 400));
const exec = await client.callTool({ name: "ctx_execute", arguments: { language: "javascript", code: "console.log('sandbox-ok')" } });
console.log("CTX_EXECUTE", exec.isError === true ? "ERROR" : "OK");
console.log((exec.content?.[0]?.text ?? "").slice(0, 200));
const doctor = await client.callTool({ name: "hc_doctor", arguments: {} });
console.log("HC_DOCTOR", doctor.isError === true ? "FAIL" : "OK");
console.log((doctor.content?.[0]?.text ?? "").split("\n").slice(0, 6).join("\n"));
await client.close();
