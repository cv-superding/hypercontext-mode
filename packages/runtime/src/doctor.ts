import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildPolicy,
  collectStats,
  ensureBillionConfig,
  federatedSearch,
  getHypercontextPaths,
  type HypercontextConfig,
} from "@hypercontext/core";
import { getEngineStatus, probeProxy } from "./engines.ts";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 18;

function checkNode(): DoctorCheck {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = (major ?? 0) > MIN_NODE_MAJOR || ((major ?? 0) === MIN_NODE_MAJOR && (minor ?? 0) >= MIN_NODE_MINOR);
  return {
    id: "node",
    title: "Node.js",
    status: ok ? "pass" : "fail",
    detail: `${process.version} (requires >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} for native TypeScript execution)`,
    fix: ok ? undefined : "Install Node.js 22.18+ or 24 LTS",
  };
}

function checkConfig(config: HypercontextConfig): DoctorCheck {
  return {
    id: "config",
    title: "Unified config",
    status: "pass",
    detail: `loaded ${getHypercontextPaths().configFile} (profile=${config.profile})`,
  };
}

async function checkProxy(config: HypercontextConfig): Promise<DoctorCheck> {
  const policy = buildPolicy({ config });
  if (!policy.compressionEnabled) {
    return {
      id: "proxy",
      title: "Compression proxy",
      status: "pass",
      detail: "disabled by config",
    };
  }
  const health = await probeProxy(policy.proxyOrigin);
  if (health.ok) {
    return {
      id: "proxy",
      title: "Compression proxy",
      status: "pass",
      detail: `healthy at ${policy.proxyOrigin} (v${health.version ?? "?"}, pid ${health.pid ?? "?"})`,
    };
  }
  let portInUse = false;
  try {
    const response = await fetch(`${policy.proxyOrigin}/`, { signal: AbortSignal.timeout(1000) });
    await response.text();
    portInUse = true;
  } catch {
    portInUse = false;
  }
  return {
    id: "proxy",
    title: "Compression proxy",
    status: portInUse ? "fail" : "warn",
    detail: portInUse
      ? `${policy.proxyOrigin} is occupied by something that is not a healthy billion-context proxy`
      : `not running at ${policy.proxyOrigin}`,
    fix: portInUse ? "Change compression.port in the unified config" : "Run: hctx start",
  };
}

function checkStorage(config: HypercontextConfig): DoctorCheck[] {
  const paths = getHypercontextPaths();
  const checks: DoctorCheck[] = [];
  try {
    const probeFile = join(paths.stateDir, ".write-probe");
    writeFileSync(probeFile, "ok", "utf8");
    rmSync(probeFile, { force: true });
    checks.push({
      id: "storage-writable",
      title: "Storage",
      status: "pass",
      detail: `${paths.home} is writable`,
    });
  } catch (error) {
    checks.push({
      id: "storage-writable",
      title: "Storage",
      status: "fail",
      detail: `cannot write to ${paths.home}: ${String(error)}`,
      fix: "Check permissions or set HYPERCONTEXT_HOME to a writable directory",
    });
  }

  const search = federatedSearch({ query: "hypercontext doctor probe", limit: 1 });
  if (search.diagnostics.errors.length > 0) {
    checks.push({
      id: "storage-readable",
      title: "Store integrity",
      status: "warn",
      detail: `some stores could not be read: ${search.diagnostics.errors.slice(0, 3).join("; ")}`,
      fix: "Inspect or remove the unreadable SQLite files; they may be locked or corrupt",
    });
  } else {
    checks.push({
      id: "storage-readable",
      title: "Store integrity",
      status: "pass",
      detail: `${search.diagnostics.contentDbs} content DB(s), ${search.diagnostics.sessionDbs} session DB(s), compression index ${search.diagnostics.compressionIndex ? "present" : "not created yet"}`,
    });
  }

  const stats = collectStats();
  checks.push({
    id: "stats",
    title: "Accounting",
    status: "pass",
    detail: `sandbox avoided ${stats.sandbox.bytesAvoided} bytes; compression blocks ${stats.compression.activeBlocks}; storage ${stats.storageBytes} bytes`,
  });
  return checks;
}

function checkUpdateChannels(config: HypercontextConfig): DoctorCheck {
  const paths = getHypercontextPaths();
  const autoUpdatesOff = !config.compression.autoUpdate && !config.update.auto;
  let biliConfigOk = true;
  let detail = "unified policy keeps automatic updates off";
  if (existsSync(paths.compressionConfigFile)) {
    try {
      const raw = JSON.parse(readFileSync(paths.compressionConfigFile, "utf8")) as Record<string, unknown>;
      biliConfigOk = raw.autoUpdate === false && raw.advisoryCheck === false && raw.releaseNotesCheck === false;
      if (!biliConfigOk) detail = `compression config enables an update channel: ${JSON.stringify(raw)}`;
    } catch {
      biliConfigOk = false;
      detail = `cannot parse ${paths.compressionConfigFile}`;
    }
  }
  return {
    id: "updates",
    title: "Update channels",
    status: autoUpdatesOff && biliConfigOk ? "pass" : "fail",
    detail,
    fix: autoUpdatesOff && biliConfigOk ? undefined : "Run: hctx doctor --fix (rewrites only the managed update flags)",
  };
}

function checkEngines(): DoctorCheck {
  const status = getEngineStatus();
  const missing: string[] = [];
  if (!status.contextMode.built) missing.push("context-mode");
  if (!status.billionContext.built) missing.push("billion-context");
  return {
    id: "engines",
    title: "Engines",
    status: missing.length === 0 ? "pass" : "fail",
    detail:
      missing.length === 0
        ? `context-mode ${status.contextMode.version ?? "?"} · billion-context ${status.billionContext.version ?? "?"} · node ${status.node}`
        : `missing build: ${missing.join(", ")}`,
    fix: missing.length === 0 ? undefined : "Run: npm run setup:engines && npm run build:engines",
  };
}

function checkPolicy(config: HypercontextConfig): DoctorCheck[] {
  const policy = buildPolicy({ config });
  return policy.warnings.map((warning, index) => ({
    id: `policy-${index + 1}`,
    title: "Policy",
    status: "warn" as const,
    detail: warning,
  }));
}

export async function runDoctor(config: HypercontextConfig): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkNode(),
    checkConfig(config),
    checkEngines(),
    checkUpdateChannels(config),
    ...checkStorage(config),
    ...checkPolicy(config),
    await checkProxy(config),
  ];
  return { checks, ok: checks.every((check) => check.status !== "fail") };
}

export function fixManagedUpdateFlags(): boolean {
  return ensureBillionConfig().changed;
}
