import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  buildPolicy,
  collectStats,
  federatedSearch,
  getEnginePaths,
  getHypercontextPaths,
  type HypercontextConfig,
} from "@hypercontext/core";
import { contextModeChildEnv, resolveWorkspaceDir } from "./engines.ts";
import { getDaemonStatus } from "./daemon.ts";
import { formatDoctor, formatProxyOverview, formatSearchResult, formatStats } from "./format.ts";
import { runDoctor } from "./doctor.ts";

const SERVER_NAME = "hypercontext-mode";
const SERVER_VERSION = "0.1.0";

const LOCAL_TOOLS: Tool[] = [
  {
    name: "hc_search",
    description:
      "Search BOTH HyperContext layers in one call: indexed tool/web/file content and session events (sandbox layer), plus compressed conversation summaries and original messages (compression layer). Use this instead of searching each store separately.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword query." },
        scope: {
          type: "string",
          enum: ["all", "sandbox", "compression"],
          description: "Limit to one layer. Default: all.",
        },
        limit: { type: "number", description: "Max hits (default 10, max 100)." },
        all_projects: {
          type: "boolean",
          description: "Search every project instead of only the current one. Default: false.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "hc_status",
    description:
      "One report for the whole context stack: sandbox bytes avoided, FTS5 memory, compressed blocks/tokens, proxy health and the active coordination policy.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hc_doctor",
    description:
      "Diagnose the unified runtime: Node, engine builds, proxy, storage readability, update channels and double-compression policy conflicts.",
    inputSchema: { type: "object", properties: {} },
  },
];

interface BridgeOptions {
  config: HypercontextConfig;
  client?: string;
  projectDir?: string;
}

class ContextModeBridge {
  private client: Client | null = null;
  private connecting: Promise<Client | null> | null = null;
  private toolsCache: { tools: Tool[]; at: number } | null = null;
  private stderrStream: WriteStream | null = null;
  private readonly options: BridgeOptions;

  constructor(options: BridgeOptions) {
    this.options = options;
  }

  private async connect(): Promise<Client | null> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<Client | null> {
    try {
      const engines = getEnginePaths();
      const env = contextModeChildEnv(this.options);
      const envRecord: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") envRecord[key] = value;
      }
      const paths = getHypercontextPaths();
      this.stderrStream = createWriteStream(join(paths.logsDir, "mcp-child.log"), { flags: "a" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [engines.contextMode.server],
        env: envRecord,
        cwd: resolveWorkspaceDir(this.options.projectDir),
        stderr: "pipe",
        maxBufferSize: 32 * 1024 * 1024,
      });
      if (transport.stderr) {
        transport.stderr.on("data", (chunk: Buffer | string) => {
          this.stderrStream?.write(chunk);
        });
      }
      const client = new Client({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: {} });
      await client.connect(transport);
      this.client = client;
      return client;
    } catch (error) {
      process.stderr.write(`hypercontext: context-mode MCP child failed to start: ${String(error)}\n`);
      this.client = null;
      return null;
    }
  }

  async listTools(): Promise<Tool[]> {
    const now = Date.now();
    if (this.toolsCache && now - this.toolsCache.at < 15_000) return this.toolsCache.tools;
    const client = await this.connect();
    if (!client) return [];
    try {
      const result = await client.listTools();
      const tools = result.tools ?? [];
      this.toolsCache = { tools, at: now };
      return tools;
    } catch (error) {
      process.stderr.write(`hypercontext: context-mode tools/list failed: ${String(error)}\n`);
      this.client = null;
      return [];
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.connect();
    if (!client) {
      return {
        content: [
          {
            type: "text",
            text: "The context-mode sandbox MCP child is unavailable. Run `hctx doctor` and check the engine build, then retry.",
          },
        ],
        isError: true,
      };
    }
    try {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return result;
    } catch (error) {
      this.client = null;
      return {
        content: [
          {
            type: "text",
            text: `context-mode tool "${name}" failed: ${String(error)}. Run \`hctx doctor\`.`,
          },
        ],
        isError: true,
      };
    }
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // ignore
    }
    this.client = null;
    this.stderrStream?.end();
    this.stderrStream = null;
  }
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

async function statusText(config: HypercontextConfig): Promise<string> {
  const policy = buildPolicy({ config });
  const daemon = await getDaemonStatus(config);
  const stats = collectStats();
  const lines: string[] = [];
  lines.push("HyperContext status");
  lines.push(`  policy: ${policy.mode}  routing=${policy.routingMode}  memory=${policy.memoryInjection}`);
  lines.push(
    `  proxy: ${daemon.health.ok ? `healthy at ${policy.proxyOrigin}` : `not running at ${policy.proxyOrigin}`}` +
      (daemon.health.version ? ` (v${daemon.health.version})` : ""),
  );
  if (daemon.overview) lines.push(`  ${formatProxyOverview(daemon.overview)}`);
  if (policy.warnings.length > 0) {
    lines.push(`  warnings: ${policy.warnings.length}`);
    for (const warning of policy.warnings) lines.push(`    - ${warning}`);
  }
  lines.push("");
  lines.push(formatStats(stats));
  return lines.join("\n");
}

export interface UnifiedMcpOptions extends BridgeOptions {}

export async function runUnifiedMcp(options: UnifiedMcpOptions): Promise<void> {
  const bridge = new ContextModeBridge(options);
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "HyperContext combines a sandbox layer (ctx_* tools) with a compression proxy. Use ctx_* to keep raw tool output out of context. Use hc_search to search indexed artifacts, session memory and compressed conversation summaries in one call. Use hc_status for the unified report.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const childTools = await bridge.listTools();
    const localNames = new Set(LOCAL_TOOLS.map((tool) => tool.name));
    const merged = [...LOCAL_TOOLS, ...childTools.filter((tool) => !localNames.has(tool.name))];
    return { tools: merged };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (name === "hc_search") {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) return textResult("hc_search requires a non-empty query.", true);
      const scope = args.scope === "sandbox" || args.scope === "compression" ? args.scope : "all";
      const limit = typeof args.limit === "number" ? args.limit : 10;
      return textResult(
        formatSearchResult(
          federatedSearch({
            query,
            scope,
            limit,
            projectDir: resolveWorkspaceDir(options.projectDir),
            allProjects: args.all_projects === true,
          }),
        ),
      );
    }
    if (name === "hc_status") {
      return textResult(await statusText(options.config));
    }
    if (name === "hc_doctor") {
      const report = await runDoctor(options.config);
      return textResult(formatDoctor(report.checks), !report.ok);
    }
    if (name.startsWith("ctx_")) {
      return bridge.callTool(name, args);
    }
    return textResult(
      `Unknown tool "${name}". HyperContext exposes ctx_* sandbox tools plus hc_search, hc_status and hc_doctor.`,
      true,
    );
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (): Promise<void> => {
    await bridge.close();
    try {
      await server.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}
