import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildPolicy,
  getEnginePaths,
  getHypercontextPaths,
  listClients,
  resolveClient,
  runtimeEnv,
  type ClientDefinition,
  type HypercontextConfig,
} from "@hypercontext/core";
import { requireBuiltEngines } from "./engines.ts";

// Only platforms whose settings are a simple `hooks` map and whose generated
// commands point at on-disk hook scripts are safe to merge generically. Every
// other client still gets the unified MCP endpoint and compression proxy.
const SUPPORTED_HOOK_PLATFORMS = new Set([
  "claude-code",
  "gemini-cli",
  "qwen-code",
]);

export interface ClientArtifacts {
  client: string;
  mcpConfigFile: string;
  launcherCmd: string;
  launcherSh: string;
  hookSupported: boolean;
  applyPluginCommand?: string[];
  notes: string[];
}

export interface ApplyOptions {
  applyPlugin?: boolean;
  applyHooks?: boolean;
  config: HypercontextConfig;
  projectDir?: string;
  /** When set, host config is only modified for clients detected on disk. */
  applyOnlyDetected?: boolean;
}

function repoHctxBin(): string {
  // packages/runtime/src -> repo root
  const repo = resolve(import.meta.dirname, "../../..");
  return join(repo, "bin", "hctx.mjs");
}

function shimDir(): string {
  return join(getHypercontextPaths().home, "bin");
}

export function writeClientArtifacts(client: ClientDefinition): ClientArtifacts {
  const paths = getHypercontextPaths();
  const clientDir = join(paths.clientStateDir, client.id);
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(shimDir(), { recursive: true });

  const hctx = repoHctxBin();
  const mcpConfig = {
    mcpServers: {
      hypercontext: {
        command: process.execPath,
        args: [hctx, "mcp", "--client", client.id],
        env: { HYPERCONTEXT_HOME: paths.home },
      },
    },
  };
  const mcpConfigFile = join(clientDir, "mcp.json");
  writeFileSync(mcpConfigFile, `${JSON.stringify(mcpConfig, null, 2)}\n`, "utf8");

  const launcherCmd = join(shimDir(), `${client.id}.cmd`);
  writeFileSync(
    launcherCmd,
    `@echo off\r\nset "HYPERCONTEXT_HOME=${paths.home}"\r\n"${process.execPath}" "${hctx}" launch ${client.id} %*\r\n`,
    "utf8",
  );

  const launcherSh = join(shimDir(), `${client.id}.sh`);
  writeFileSync(
    launcherSh,
    `#!/bin/sh\nexport HYPERCONTEXT_HOME="${paths.home}"\nexec "${process.execPath}" "${hctx}" launch ${client.id} "$@"\n`,
    "utf8",
  );
  if (process.platform !== "win32") {
    try {
      chmodSync(launcherSh, 0o755);
    } catch {
      // best effort
    }
  }

  const notes: string[] = [];
  if (client.compression.launcher) {
    notes.push(`start: "${launcherCmd}" (or "hctx launch ${client.id}")`);
  } else {
    notes.push("no launcher: start the proxy with hctx start, then point the model base URL at it");
  }
  notes.push(`MCP config snippet: ${mcpConfigFile}`);
  if (!client.sandbox.hooks) {
    notes.push("no automatic hook routing for this client; use the unified MCP tools");
  }

  return {
    client: client.id,
    mcpConfigFile,
    launcherCmd,
    launcherSh,
    hookSupported: Boolean(client.sandbox.platform && SUPPORTED_HOOK_PLATFORMS.has(client.sandbox.platform)),
    applyPluginCommand: client.compression.plugin
      ? [process.execPath, getEnginePaths().billionContext.distEntry, "plugin", "install", client.compression.plugin]
      : undefined,
    notes,
  };
}

function rewriteHookCommands(
  registration: Record<string, unknown>,
  platform: string,
): Record<string, unknown> {
  const wrapper = join(import.meta.dirname, "hook-wrapper.ts");
  const home = getHypercontextPaths().home;
  const rewriteCommand = (command: string): string => {
    const scriptMatch = command.match(/hooks[\\/]([a-z0-9-]+(?:[\\/][a-z0-9-]+)*\.mjs)/i);
    const script = (scriptMatch?.[1] ?? "pretooluse.mjs").replace(/\\/g, "/");
    return `"${process.execPath}" "${wrapper}" --home "${home}" ${platform} ${script}`;
  };

  const walk = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (key === "command") return rewriteCommand(value);
      return value;
    }
    if (Array.isArray(value)) return value.map((entry) => walk(entry, key));
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(value)) {
        result[childKey] = walk(child, childKey);
      }
      return result;
    }
    return value;
  };
  return walk(registration) as Record<string, unknown>;
}

export interface HookInstallResult {
  platform: string;
  changes: string[];
  backup?: string | null;
  error?: string;
}

function isHypercontextHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as { hooks?: Array<{ command?: string }> }).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) => {
    const command = hook.command ?? "";
    return (
      command.includes("hook-wrapper") ||
      command.includes("context-mode hook") ||
      (command.includes("context-mode") && command.includes(".mjs")) ||
      /hooks[\\/](?:pretooluse|posttooluse|precompact|sessionstart|userpromptsubmit|stop)\.mjs/.test(command)
    );
  });
}

function installGeneratedHooks(
  adapter: Record<string, unknown>,
  generated: Record<string, unknown>,
): string[] {
  const readSettings = adapter.readSettings as () => Record<string, unknown> | null;
  const writeSettings = adapter.writeSettings as (settings: Record<string, unknown>) => void;
  const settings = readSettings.call(adapter) ?? {};
  const hooks = { ...((settings.hooks ?? {}) as Record<string, unknown>) };
  const changes: string[] = [];

  for (const [event, entries] of Object.entries(generated)) {
    if (!Array.isArray(entries)) continue;
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]).filter((entry) => !isHypercontextHookEntry(entry)) : [];
    hooks[event] = [...existing, ...entries];
    changes.push(`${event}: ${entries.length} hook entr${entries.length === 1 ? "y" : "ies"}`);
  }

  settings.hooks = hooks;
  writeSettings.call(adapter, settings);
  return changes;
}

export async function installHooks(
  client: ClientDefinition,
  config: HypercontextConfig,
  projectDir?: string,
): Promise<HookInstallResult> {
  const platform = client.sandbox.platform;
  if (!platform) return { platform: "", changes: [], error: "No hook platform for this client." };
  if (!SUPPORTED_HOOK_PLATFORMS.has(platform)) {
    return { platform, changes: [], error: `Hook installation is not supported yet for ${client.label}.` };
  }
  requireBuiltEngines("context");
  const engines = getEnginePaths();
  process.env.CONTEXT_MODE_DIR = getHypercontextPaths().contextDataDir;
  process.env.CONTEXT_MODE_DATA_DIR = getHypercontextPaths().contextDataDir;
  process.env.CONTEXT_MODE_DISABLE_UPDATE_CHECK = "1";
  const previousCwd = process.cwd();
  if (projectDir) process.chdir(projectDir);

  try {
    const detectUrl = pathToFileURL(join(engines.contextMode.root, "build", "adapters", "detect.js")).href;
    const adapterModule = (await import(detectUrl)) as {
      getAdapter: (platform: string) => Promise<Record<string, unknown>>;
    };
    const adapter = await adapterModule.getAdapter(platform);
    const original = (adapter.generateHookConfig as (root: string) => Record<string, unknown>).bind(adapter);
    const generated = rewriteHookCommands(original(engines.contextMode.root), platform);
    const backup = (adapter.backupSettings as () => string | null)();

    // Upstream's standalone installers register subsets (Claude: 2 events,
    // Gemini: 3) because the plugin path normally covers the rest. Merge the
    // adapter's full generated registration so session memory works without
    // the marketplace plugin.
    const changes = installGeneratedHooks(adapter, generated);

    try {
      (adapter.setHookPermissions as (root: string) => string[])(engines.contextMode.root);
    } catch {
      // permissions are best effort on Windows
    }
    return { platform, changes, backup };
  } catch (error) {
    return { platform, changes: [], error: String(error) };
  } finally {
    if (projectDir) process.chdir(previousCwd);
  }
}

export interface SetupResult {
  client: string;
  artifacts: ClientArtifacts;
  hookResult?: HookInstallResult;
  pluginOutput?: string;
  pluginError?: string;
  hostChanged: boolean;
}

export async function setupClients(
  names: string[],
  options: ApplyOptions,
): Promise<SetupResult[]> {
  const clients = names.length > 0 ? names.map((name) => resolveClient(name)).filter(Boolean) as ClientDefinition[] : [...listClients()];
  const detectedIds = new Set(
    options.applyOnlyDetected
      ? detectInstalledClients().filter((entry) => entry.detected).map((entry) => entry.client.id)
      : clients.map((client) => client.id),
  );
  const results: SetupResult[] = [];

  for (const client of clients) {
    const artifacts = writeClientArtifacts(client);
    const result: SetupResult = { client: client.id, artifacts, hostChanged: false };
    const canApplyHost = detectedIds.has(client.id);

    if (options.applyHooks || options.applyPlugin) {
      if (!canApplyHost) {
        result.artifacts.notes.push("client not detected; artifacts were written but host config was not modified");
      }
    }

    if (options.applyHooks && canApplyHost) {
      result.hookResult = await installHooks(client, options.config, options.projectDir);
      if (!result.hookResult.error) result.hostChanged = true;
    }

    if (options.applyPlugin && canApplyHost && client.compression.plugin) {
      requireBuiltEngines("compression");
      const policy = buildPolicy({ config: options.config, client: client.id });
      const { runProcess } = await import("./process.ts");
      const run = await runProcess(
        process.execPath,
        [getEnginePaths().billionContext.distEntry, "plugin", "install", client.compression.plugin],
        { env: runtimeEnv(policy), cwd: process.cwd() },
      );
      result.pluginOutput = run.stdout.trim();
      if (run.code !== 0) result.pluginError = run.stderr.trim() || `exit ${run.code}`;
      else result.hostChanged = true;
    }

    results.push(result);
  }
  return results;
}

const DETECT_PATHS: Record<string, string[]> = {
  "claude-code": [".claude"],
  codex: [".codex"],
  "gemini-cli": [".gemini"],
  "qwen-code": [".qwen"],
  opencode: [".config/opencode", "AppData/Roaming/opencode"],
  cursor: [".cursor", "AppData/Roaming/Cursor"],
  "copilot-cli": [".copilot"],
  zed: [".config/zed", "AppData/Roaming/Zed"],
  openclaw: [".openclaw"],
  "qoder-intl": ["AppData/Roaming/Qoder", "AppData/Local/Qoder", ".qoder"],
  "qoder-cn": ["AppData/Roaming/Qoder", "AppData/Local/Qoder", ".qoder"],
  "workbuddy-intl": ["AppData/Roaming/WorkBuddy", "AppData/Local/WorkBuddy", ".workbuddy"],
  "workbuddy-cn": ["AppData/Roaming/WorkBuddy", "AppData/Local/WorkBuddy", ".workbuddy"],
  trae: ["AppData/Roaming/Trae", ".trae"],
  codebuddy: ["AppData/Roaming/CodeBuddy", ".codebuddy"],
  kimi: [".kimi"],
  hermes: [".hermes"],
  dsh: [".dsh"],
};

export function detectInstalledClients(): Array<{ client: ClientDefinition; detected: boolean; hints: string[] }> {
  const home = homedir();
  return listClients().map((client) => {
    const relatives = DETECT_PATHS[client.id] ?? [];
    const hints = relatives
      .map((relative) => (relative.startsWith("AppData/") ? join(home, relative) : join(home, relative)))
      .filter((candidate) => {
        try {
          return existsSync(candidate) && statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      });
    return { client, detected: hints.length > 0, hints };
  });
}
