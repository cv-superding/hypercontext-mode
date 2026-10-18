import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  buildPolicy,
  getEnginePaths,
  getHypercontextPaths,
  resolveClient,
  runtimeEnv,
  type HypercontextConfig,
} from "@hypercontext/core";

export interface EngineStatus {
  contextMode: {
    root: string;
    built: boolean;
    version?: string;
  };
  billionContext: {
    root: string;
    built: boolean;
    version?: string;
  };
  node: string;
}

export function readPackageVersion(file: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export function getEngineStatus(): EngineStatus {
  const engines = getEnginePaths();
  return {
    contextMode: {
      root: engines.contextMode.root,
      built: existsSync(engines.contextMode.server),
      version: readPackageVersion(engines.contextMode.packageJson),
    },
    billionContext: {
      root: engines.billionContext.root,
      built: existsSync(engines.billionContext.distEntry),
      version: readPackageVersion(engines.billionContext.packageJson),
    },
    node: process.version,
  };
}

export function requireBuiltEngines(which: "both" | "context" | "compression" = "both"): void {
  const status = getEngineStatus();
  const missing: string[] = [];
  if ((which === "both" || which === "context") && !status.contextMode.built) {
    missing.push(`context-mode (expected ${getEnginePaths().contextMode.server})`);
  }
  if ((which === "both" || which === "compression") && !status.billionContext.built) {
    missing.push(`billion-context (expected ${getEnginePaths().billionContext.distEntry})`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Engine build missing: ${missing.join(", ")}.\nRun: npm run setup:engines && npm run build:engines`,
    );
  }
}

export interface ProxyHealth {
  ok: boolean;
  version?: string;
  commit?: string;
  pid?: number;
  startedAt?: number;
  reason?: string;
  raw?: unknown;
}

export async function probeProxy(origin: string, timeoutMs = 1500): Promise<ProxyHealth> {
  try {
    const response = await fetch(`${origin.replace(/\/$/, "")}/__bili/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text.slice(0, 500);
    }
    const record = (raw ?? {}) as Record<string, unknown>;
    return {
      ok: response.ok && record.ok === true,
      version: typeof record.version === "string" ? record.version : undefined,
      commit: typeof record.commit === "string" ? record.commit : undefined,
      pid: typeof record.pid === "number" ? record.pid : undefined,
      startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
      reason: typeof record.reason === "string" ? record.reason : undefined,
      raw,
    };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

export async function fetchProxyStatus(origin: string, timeoutMs = 2000): Promise<unknown> {
  try {
    const response = await fetch(`${origin.replace(/\/$/, "")}/__bili/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return await response.json();
  } catch (error) {
    return { error: String(error) };
  }
}

export interface ProxyOverview {
  sessions: number;
  live: number;
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  tokensSaved: number;
  hitPct: number | null;
  blocks: number;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function fetchProxyOverview(origin: string, timeoutMs = 2000): Promise<ProxyOverview | null> {
  try {
    const response = await fetch(`${origin.replace(/\/$/, "")}/__bili/overview`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { overview?: Record<string, unknown> };
    const overview = payload.overview;
    if (!overview) return null;
    return {
      sessions: asNumber(overview.sessions),
      live: asNumber(overview.live),
      requests: asNumber(overview.requests),
      inputTokens: asNumber(overview.inputTokens),
      cachedTokens: asNumber(overview.cachedTokens),
      outputTokens: asNumber(overview.outputTokens),
      tokensSaved: asNumber(overview.tokensSaved),
      hitPct: typeof overview.hitPct === "number" && Number.isFinite(overview.hitPct) ? overview.hitPct : null,
      blocks: asNumber(overview.blocks),
    };
  } catch {
    return null;
  }
}

export interface SpawnProxyResult {
  pid?: number;
  origin: string;
  mode: "managed" | "external";
  version?: string;
  logFile: string;
}

export interface SpawnProxyOptions {
  config: HypercontextConfig;
  foreground?: boolean;
}

export async function spawnProxy(options: SpawnProxyOptions): Promise<SpawnProxyResult> {
  const paths = getHypercontextPaths();
  const policy = buildPolicy({ config: options.config });
  const origin = policy.proxyOrigin;
  const existing = await probeProxy(origin);
  if (existing.ok) {
    return {
      pid: existing.pid,
      origin,
      mode: "external",
      version: existing.version,
      logFile: paths.daemonLogFile,
    };
  }

  requireBuiltEngines("compression");
  const engines = getEnginePaths();
  const env = runtimeEnv(policy);
  const args = [
    engines.billionContext.distEntry,
    "start",
    "--port",
    String(options.config.compression.port),
    "--host",
    options.config.compression.host,
  ];

  if (options.foreground) {
    const child = spawn(process.execPath, args, {
      cwd: engines.billionContext.root,
      env,
      stdio: "inherit",
      windowsHide: false,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`billion-context exited with code ${code ?? "unknown"}`));
      });
      child.once("error", reject);
    });
    return { origin, mode: "managed", logFile: paths.daemonLogFile };
  }

  const { openSync } = await import("node:fs");
  const logFd = openSync(paths.daemonLogFile, "a");
  const child = spawn(process.execPath, args, {
    cwd: engines.billionContext.root,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  const deadline = Date.now() + 20_000;
  let last: ProxyHealth = { ok: false };
  while (Date.now() < deadline) {
    await sleep(250);
    last = await probeProxy(origin);
    if (last.ok) {
      return {
        pid: last.pid ?? child.pid,
        origin,
        mode: "managed",
        version: last.version,
        logFile: paths.daemonLogFile,
      };
    }
    if (child.exitCode !== null) break;
  }

  throw new Error(
    `Compression proxy did not become healthy at ${origin}. ${last.reason ?? ""}\nSee ${paths.daemonLogFile}`,
  );
}

export async function shutdownProxy(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin.replace(/\/$/, "")}/__bili/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ContextModeChildOptions {
  config: HypercontextConfig;
  client?: string;
  projectDir?: string;
}

/**
 * Desktop hosts (Qoder, WorkBuddy, …) spawn the MCP child from the app's own
 * install directory, so `process.cwd()` is not the workspace. An explicit
 * CONTEXT_MODE_PROJECT_DIR has to win over it, otherwise context-mode's
 * workspace containment rejects every file in the real project.
 */
export function resolveWorkspaceDir(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit;
  const declared = process.env.CONTEXT_MODE_PROJECT_DIR?.trim();
  if (declared && declared.length > 0) return declared;
  return process.cwd();
}

export function contextModeChildEnv(options: ContextModeChildOptions): NodeJS.ProcessEnv {
  const policy = buildPolicy({ config: options.config, client: options.client });
  const projectDir = resolveWorkspaceDir(options.projectDir);
  const clientPlatform = options.client ? resolveClient(options.client)?.sandbox.platform : undefined;
  const env = runtimeEnv(policy, {
    CONTEXT_MODE_PROJECT_DIR: projectDir,
    HYPERCONTEXT_CLIENT: options.client ?? "",
    ...(clientPlatform === "claude-code" ? { CLAUDE_PROJECT_DIR: projectDir } : {}),
  });
  if (clientPlatform) env.CONTEXT_MODE_PLATFORM = clientPlatform;
  return env;
}

export interface LaunchPlan {
  launcher?: string;
  command: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  note: string;
}

export function planClientLaunch(
  clientId: string,
  config: HypercontextConfig,
  clientArgs: string[] = [],
): LaunchPlan {
  const client = resolveClient(clientId);
  if (!client) throw new Error(`Unknown client "${clientId}"`);
  const policy = buildPolicy({ config, client: client.id });
  const env = runtimeEnv(policy, { HYPERCONTEXT_CLIENT: client.id });
  const engines = getEnginePaths();
  const launcher = client.compression.launcher;

  if (!launcher) {
    return {
      command: [],
      env,
      cwd: process.cwd(),
      note: `${client.label} has no one-command launcher in billion-context. Start the proxy with "hctx start" and point the client's model base URL at ${policy.proxyOrigin}/bili/<upstream-url>, or use "hctx mcp --client ${client.id}" for the sandbox tools.`,
    };
  }

  return {
    launcher,
    command: [process.execPath, engines.billionContext.distEntry, launcher, ...clientArgs],
    env,
    cwd: process.cwd(),
    note: `Launching ${client.label} through the compression proxy.`,
  };
}
