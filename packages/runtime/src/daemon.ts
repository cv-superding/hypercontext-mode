import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  buildPolicy,
  getHypercontextPaths,
  type HypercontextConfig,
} from "@hypercontext/core";
import {
  fetchProxyOverview,
  fetchProxyStatus,
  probeProxy,
  shutdownProxy,
  sleep,
  spawnProxy,
  type ProxyHealth,
  type ProxyOverview,
} from "./engines.ts";

export interface DaemonState {
  version: 1;
  mode: "managed" | "external";
  pid?: number;
  origin: string;
  host: string;
  port: number;
  startedAt: string;
  engineVersion?: string;
  logFile: string;
}

export interface DaemonStatus {
  state: DaemonState | null;
  health: ProxyHealth;
  stale: boolean;
  proxyStatus?: unknown;
  overview?: ProxyOverview | null;
}

export function readDaemonState(): DaemonState | null {
  const paths = getHypercontextPaths();
  if (!existsSync(paths.daemonStateFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(paths.daemonStateFile, "utf8")) as Partial<DaemonState>;
    if (
      parsed.version !== 1 ||
      (parsed.mode !== "managed" && parsed.mode !== "external") ||
      typeof parsed.origin !== "string"
    ) {
      return null;
    }
    return parsed as DaemonState;
  } catch {
    return null;
  }
}

export function writeDaemonState(state: DaemonState): void {
  const paths = getHypercontextPaths();
  writeFileSync(paths.daemonStateFile, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function clearDaemonState(): void {
  const paths = getHypercontextPaths();
  try {
    rmSync(paths.daemonStateFile, { force: true });
  } catch {
    // best effort
  }
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startDaemon(
  config: HypercontextConfig,
  options: { foreground?: boolean; restart?: boolean } = {},
): Promise<DaemonState> {
  const paths = getHypercontextPaths();
  const policy = buildPolicy({ config });
  const origin = policy.proxyOrigin;

  const existingHealth = await probeProxy(origin);
  if (existingHealth.ok) {
    const state: DaemonState = {
      version: 1,
      mode: "external",
      pid: existingHealth.pid,
      origin,
      host: config.compression.host,
      port: config.compression.port,
      startedAt: existingHealth.startedAt
        ? new Date(existingHealth.startedAt).toISOString()
        : new Date().toISOString(),
      engineVersion: existingHealth.version,
      logFile: paths.daemonLogFile,
    };
    writeDaemonState(state);
    return state;
  }

  if (options.restart) {
    await stopDaemon(config);
  } else {
    const previous = readDaemonState();
    if (previous) {
      if (previous.mode === "managed" && isPidAlive(previous.pid)) {
        throw new Error(
          `A managed proxy process (pid ${previous.pid}) is recorded but not healthy at ${origin}. Run "hctx stop" first, or "hctx start --restart".`,
        );
      }
      clearDaemonState();
    }
  }

  const spawned = await spawnProxy({ config, foreground: options.foreground });
  if (options.foreground) {
    clearDaemonState();
    return {
      version: 1,
      mode: "managed",
      origin: spawned.origin,
      host: config.compression.host,
      port: config.compression.port,
      startedAt: new Date().toISOString(),
      logFile: spawned.logFile,
    };
  }

  const state: DaemonState = {
    version: 1,
    mode: spawned.mode,
    pid: spawned.pid,
    origin: spawned.origin,
    host: config.compression.host,
    port: config.compression.port,
    startedAt: new Date().toISOString(),
    engineVersion: spawned.version,
    logFile: spawned.logFile,
  };
  writeDaemonState(state);
  return state;
}

export async function stopDaemon(config: HypercontextConfig): Promise<{ stopped: boolean; reason: string }> {
  const state = readDaemonState();
  if (!state) {
    const policy = buildPolicy({ config });
    const health = await probeProxy(policy.proxyOrigin);
    if (health.ok) {
      return {
        stopped: false,
        reason: "A proxy is running but was not started by HyperContext; refusing to stop it.",
      };
    }
    return { stopped: false, reason: "No managed proxy is running." };
  }

  const health = await probeProxy(state.origin);
  if (state.mode === "external") {
    return {
      stopped: false,
      reason: "The proxy was not started by HyperContext; refusing to stop it.",
    };
  }

  if (health.ok && health.pid && state.pid && health.pid !== state.pid) {
    clearDaemonState();
    return {
      stopped: false,
      reason: `PID mismatch (state ${state.pid}, health ${health.pid}); cleared stale state without killing anything.`,
    };
  }

  const graceful = await shutdownProxy(state.origin);
  if (!graceful && state.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }

  // billion-context's graceful path flushes dirty sessions and has a 10s
  // backstop. Do not cut that short; force-killing here would drop state.
  const gracefulDeadline = Date.now() + (graceful ? 12_000 : 5_000);
  while (Date.now() < gracefulDeadline) {
    await sleep(250);
    const current = await probeProxy(state.origin, 500);
    if (!current.ok) {
      clearDaemonState();
      return { stopped: true, reason: graceful ? "Proxy shut down gracefully." : "Proxy stopped." };
    }
  }

  if (state.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone
    }
    await sleep(2000);
  }

  const remainingAfterTerm = await probeProxy(state.origin, 500);
  if (!remainingAfterTerm.ok) {
    clearDaemonState();
    return { stopped: true, reason: "Proxy stopped after graceful-exit timeout." };
  }

  if (state.pid) {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await sleep(300);
  const remaining = await probeProxy(state.origin, 500);
  if (remaining.ok) {
    return { stopped: false, reason: `Proxy still responds at ${state.origin}.` };
  }
  clearDaemonState();
  return { stopped: true, reason: "Proxy stopped (forced)." };
}

export async function getDaemonStatus(config: HypercontextConfig): Promise<DaemonStatus> {
  const state = readDaemonState();
  const policy = buildPolicy({ config });
  const health = await probeProxy(policy.proxyOrigin);
  const stale =
    state !== null &&
    state.mode === "managed" &&
    !health.ok &&
    (state.pid === undefined || !isPidAlive(state.pid));
  const proxyStatus = health.ok ? await fetchProxyStatus(policy.proxyOrigin) : undefined;
  const overview = health.ok ? await fetchProxyOverview(policy.proxyOrigin) : null;
  return { state, health, stale, proxyStatus, overview };
}

export function readDaemonLogTail(lines = 40): string {
  const paths = getHypercontextPaths();
  if (!existsSync(paths.daemonLogFile)) return "";
  try {
    const content = readFileSync(paths.daemonLogFile, "utf8").split(/\r?\n/);
    return content.slice(-Math.max(1, lines)).join("\n");
  } catch {
    return "";
  }
}
