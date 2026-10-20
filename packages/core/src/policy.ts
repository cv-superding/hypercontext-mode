import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveMcpToolset,
  type CompressionMode,
  type HypercontextConfig,
  type MemoryInjection,
  type Profile,
  type RoutingMode,
} from "./config.ts";
import { ensureHypercontextDirs, getHypercontextPaths } from "./paths.ts";
import { resolveClient, type ClientDefinition } from "./clients.ts";

export interface RuntimePolicy {
  mode: "full" | "sandbox-only" | "compression-only" | "off";
  profile: Profile;
  sandboxEnabled: boolean;
  compressionEnabled: boolean;
  compressionMode: CompressionMode;
  coldStartTokens: number;
  /** Whether the compression surface is injected into the request. */
  injectionEnabled: boolean;
  mcpToolset: "full" | "lean";
  routingMode: RoutingMode;
  memoryInjection: Exclude<MemoryInjection, "auto">;
  proxyOrigin: string;
  env: Record<string, string>;
  warnings: string[];
}

export interface PolicyOptions {
  client?: string;
  config: HypercontextConfig;
}

function effectiveFlags(config: HypercontextConfig, client?: ClientDefinition): {
  sandbox: boolean;
  compression: boolean;
} {
  const override = client ? config.clients[client.id] : undefined;
  return {
    sandbox: override?.sandbox ?? config.sandbox.enabled,
    compression: override?.compression ?? config.compression.enabled,
  };
}

function effectiveMemoryInjection(
  config: HypercontextConfig,
  compressionEnabled: boolean,
): Exclude<MemoryInjection, "auto"> {
  if (config.sandbox.memoryInjection !== "auto") return config.sandbox.memoryInjection;
  return compressionEnabled ? "minimal" : "full";
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function buildPolicy(options: PolicyOptions): RuntimePolicy {
  const { config } = options;
  const client = options.client ? resolveClient(options.client) : undefined;
  const flags = effectiveFlags(config, client);
  const sandboxEnabled = flags.sandbox;
  const compressionEnabled = flags.compression;
  const compressionMode = config.compression.mode;
  const coldStartTokens = config.compression.coldStartTokens;
  // autoFold folds proxy-side, so the prompt/tool surface stays off there.
  // "off" also removes it from cooperative mode: the host's own compaction
  // owns the window and no folding tax is paid.
  const injectionEnabled =
    compressionMode === "autofold" ? false : config.compression.inject !== "off";
  const mcpToolset = resolveMcpToolset(config);
  const routingMode = config.sandbox.routing;
  const memoryInjection = effectiveMemoryInjection(config, compressionEnabled);
  const proxyOrigin = `http://${config.compression.host}:${config.compression.port}`;
  const warnings: string[] = [];

  if (!sandboxEnabled && !compressionEnabled) {
    warnings.push("Both layers are disabled; HyperContext will not intercept any context.");
  }
  if (!isLoopbackHost(config.compression.host)) {
    warnings.push(
      `Compression proxy is bound to ${config.compression.host}; it has no authentication. Keep it on loopback or firewall it.`,
    );
  }
  if (compressionEnabled && memoryInjection === "full") {
    warnings.push(
      "Full memory injection is enabled while compression is active; resumed snapshots can invalidate the proxy's prefix cache.",
    );
  }
  if (sandboxEnabled && routingMode === "strict") {
    warnings.push(
      "Strict routing hard-blocks WebFetch and unredirected curl/wget; use balanced mode if agents rely on those tools.",
    );
  }
  if (config.compression.autoUpdate || config.update.auto) {
    warnings.push(
      "Automatic updates are ignored in the unified runtime; update the vendored engines explicitly.",
    );
  }
  if (compressionEnabled && compressionMode === "autofold") {
    const summary = config.compression.summary;
    if (summary?.apiKeyEnv && !process.env[summary.apiKeyEnv]) {
      warnings.push(
        `Auto-fold summary credential ${summary.apiKeyEnv} is not set; summary calls will fail open until it is available to the daemon.`,
      );
    }
  }
  if (compressionEnabled && compressionMode === "cooperative" && !config.compression.summary) {
    warnings.push(
      "协作式压缩需要模型主动调用 compress。未配摘要模型时，注入的 ~4.5K token/请求会挤占宿主预算：实测让 OpenCode 自带的压缩从 2 次涨到 6 次（12 轮，总字节 +61%）。配 compression.summary 走 autoFold（代理自折叠、注入关闭），或设 compression.inject=off 由宿主自己管窗口。",
    );
  }
  if (compressionEnabled && compressionMode === "cooperative" && config.compression.inject === "off") {
    warnings.push(
      "compression.inject=off：压缩面不会注入，协作式折叠不会发生（窗口交给宿主自己的压缩）。",
    );
  }

  const paths = getHypercontextPaths();
  const env: Record<string, string> = {
    HYPERCONTEXT: "1",
    HYPERCONTEXT_HOME: paths.home,
    CONTEXT_MODE_DIR: paths.contextDataDir,
    CONTEXT_MODE_DATA_DIR: paths.contextDataDir,
    CONTEXT_MODE_DISABLE_UPDATE_CHECK: "1",
    HYPERCONTEXT_ROUTING_MODE: routingMode,
    HYPERCONTEXT_MEMORY_INJECTION: memoryInjection,
    HYPERCONTEXT_COMPRESSION: compressionEnabled ? "1" : "0",
    HYPERCONTEXT_COMPRESSION_MODE: compressionMode,
    ACP_INJECT_AFTER_TOKENS: String(coldStartTokens),
    ACP_AUTO_UPDATE: "0",
    BILI_ADVISORY_CHECK: "0",
    BILI_RELEASE_NOTES_CHECK: "0",
    BILI_CONFIG_FILE: paths.compressionConfigFile,
    BILI_SESSIONS_DIR: paths.compressionSessionsDir,
    BILI_MCP_PROXY: proxyOrigin,
    // Keep CA/state/cache under the HyperContext home as well. These are
    // inherited only by the compression engine child process.
    XDG_DATA_HOME: join(paths.dataDir, "xdg"),
    XDG_STATE_HOME: join(paths.stateDir, "xdg"),
    XDG_CACHE_HOME: join(paths.cacheDir, "xdg"),
  };

  if (sandboxEnabled) {
    env.CONTEXT_MODE_PLATFORM = client?.sandbox.platform ?? "";
  }

  // The engine reads these before the config file, so they are the only place
  // where "do not inject the compression surface" can be expressed without
  // touching the engine's config surface. AutoFold needs no env: the control
  // plane already writes injectTool/injectNudge=false into the engine config.
  if (compressionEnabled && compressionMode === "cooperative" && !injectionEnabled) {
    env.ACP_COMPRESS_TOOL = "0";
    env.ACP_COMPRESS_NUDGE = "0";
  }

  return {
    mode:
      sandboxEnabled && compressionEnabled
        ? "full"
        : sandboxEnabled
          ? "sandbox-only"
          : compressionEnabled
            ? "compression-only"
            : "off",
    profile: config.profile,
    sandboxEnabled,
    compressionEnabled,
    compressionMode,
    coldStartTokens,
    injectionEnabled,
    mcpToolset,
    routingMode,
    memoryInjection,
    proxyOrigin,
    env,
    warnings,
  };
}

export function runtimeEnv(policy: RuntimePolicy, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...policy.env, ...extra };
  for (const [key, value] of Object.entries(env)) {
    if (value === "") delete env[key];
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function setRecord(target: Record<string, unknown>, key: string, value: unknown): boolean {
  if (JSON.stringify(target[key]) === JSON.stringify(value)) return false;
  target[key] = value;
  return true;
}

interface ManagedAutofold {
  providerName: string;
  provider: Record<string, unknown>;
  externalSummary: Record<string, unknown>;
}

function clearManagedAutofold(current: Record<string, unknown>): boolean {
  const compress = current.compress;
  if (!isRecord(compress)) return false;
  const summary = compress.externalSummary;
  if (!isRecord(summary)) return false;
  const targets = Array.isArray(summary.targets) ? summary.targets : [];
  const ours = targets.length > 0
    && targets.every((target) => typeof target === "string" && target.startsWith("hctx-summary/"));
  if (!ours) return false;

  let changed = setRecord(current, "compress", {
    ...compress,
    injectTool: true,
    injectNudge: true,
    externalSummary: { ...summary, enabled: false, autoFold: false },
  });
  const providers = current.providers;
  if (isRecord(providers) && "hctx-summary" in providers) {
    const rest = { ...providers };
    delete rest["hctx-summary"];
    changed = setRecord(current, "providers", rest) || changed;
  }
  return changed;
}

function managedAutofold(config: HypercontextConfig): ManagedAutofold | null {
  if (!config.compression.enabled || config.compression.mode !== "autofold") return null;
  const summary = config.compression.summary;
  if (!summary || (!summary.apiKeyEnv && !summary.credentialRef)) return null;

  const providerName = "hctx-summary";
  const provider = {
    baseUrl: summary.baseUrl.replace(/\/+$/, ""),
    api: summary.api,
    ...(summary.apiKeyEnv
      ? { apiKeyEnv: summary.apiKeyEnv }
      : { credentialRef: summary.credentialRef }),
    models: { [summary.model]: {} },
  };
  const externalSummary = {
    enabled: true,
    targets: [`${providerName}/${summary.model}`],
    autoFold: true,
    autoFoldTargetTokens: summary.autoFoldTargetTokens,
    ...(summary.concurrency ? { concurrency: summary.concurrency } : {}),
  };
  return { providerName, provider, externalSummary };
}

/**
 * billion-context supports a large, user-owned config surface. We only manage
 * the update channels and, when auto-fold is selected, the summary provider
 * and the injection keys that mode owns. Everything is merged into the existing
 * file rather than replacing it. Invalid JSON is a hard error: silently
 * rewriting a user's config is worse than refusing to start.
 */
export function ensureBillionConfig(config?: HypercontextConfig): { file: string; changed: boolean } {
  const paths = ensureHypercontextDirs(getHypercontextPaths());
  const file = paths.compressionConfigFile;
  let current: Record<string, unknown> = {};

  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isRecord(parsed)) {
        throw new Error("expected a JSON object");
      }
      current = parsed;
    } catch (error) {
      throw new Error(
        `Cannot update ${file}: the existing file is not a valid JSON object. Fix or remove it first. (${String(error)})`,
      );
    }
  }

  let changed = !existsSync(file);
  const managed: Record<string, unknown> = {
    autoUpdate: false,
    advisoryCheck: false,
    releaseNotesCheck: false,
  };
  for (const [key, value] of Object.entries(managed)) {
    changed = setRecord(current, key, value) || changed;
  }

  const autofold = config ? managedAutofold(config) : null;
  if (autofold) {
    const providers = current.providers === undefined ? {} : current.providers;
    if (!isRecord(providers)) {
      throw new Error(`Cannot update ${file}: providers must be a JSON object.`);
    }
    changed = setRecord(current, "providers", {
      ...providers,
      [autofold.providerName]: autofold.provider,
    }) || changed;

    const compress = current.compress === undefined ? {} : current.compress;
    if (!isRecord(compress)) {
      throw new Error(`Cannot update ${file}: compress must be a JSON object.`);
    }
    const existingSummary = isRecord(compress.externalSummary) ? compress.externalSummary : {};
    changed = setRecord(current, "compress", {
      ...compress,
      injectTool: false,
      injectNudge: false,
      externalSummary: { ...existingSummary, ...autofold.externalSummary },
    }) || changed;
  } else if (config && (config.compression.mode === "cooperative" || !config.compression.enabled)) {
    changed = clearManagedAutofold(current) || changed;
  }

  if (changed) {
    writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return { file, changed };
}

export function prepareRuntime(config: HypercontextConfig, client?: string): RuntimePolicy {
  ensureHypercontextDirs(getHypercontextPaths());
  const policy = buildPolicy({ config, client });
  ensureBillionConfig(config);
  return policy;
}
