import type { SearchResult, UnifiedStats } from "@hypercontext/core";
import type { DoctorCheck } from "./doctor.ts";
import type { ProxyOverview } from "./engines.ts";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

export function formatProxyOverview(overview: ProxyOverview): string {
  const hit = overview.hitPct === null ? "n/a" : `${overview.hitPct.toFixed(1)}%`;
  return `Proxy accounting: ${formatNumber(overview.requests)} req · input ${formatNumber(overview.inputTokens)} · cached ${formatNumber(overview.cachedTokens)} (${hit} hit) · saved ${formatNumber(overview.tokensSaved)} tokens · ${formatNumber(overview.blocks)} blocks`;
}

export function formatStats(stats: UnifiedStats): string {
  const sandbox = stats.sandbox;
  const compression = stats.compression;
  const lines: string[] = [];
  lines.push("Sandbox layer (tool output + memory)");
  lines.push(`  content DBs: ${sandbox.contentDbs}  sources: ${formatNumber(sandbox.sourceCount)}  chunks: ${formatNumber(sandbox.chunkCount)}`);
  lines.push(`  session DBs: ${sandbox.sessionDbs}  sessions: ${formatNumber(sandbox.sessions)}  events: ${formatNumber(sandbox.events)}  tool calls: ${formatNumber(sandbox.toolCalls)}`);
  lines.push(
    `  returned: ${formatBytes(sandbox.bytesReturned)}  avoided: ${formatBytes(sandbox.bytesAvoided)} (≈${formatNumber(stats.estimatedTokensAvoidedBySandbox)} tokens)`,
  );
  lines.push("Compression layer (conversation history)");
  lines.push(
    `  index: ${compression.indexPresent ? "present" : "not created yet"}  sessions: ${formatNumber(compression.sessions)} (${formatNumber(compression.activeSessions)} active)`,
  );
  lines.push(
    `  messages: ${formatNumber(compression.messages)}  active blocks: ${formatNumber(compression.activeBlocks)}  compressed tokens: ${formatNumber(compression.compressedTokens)}`,
  );
  lines.push(`  proxy requests seen: ${formatNumber(compression.requests)}`);
  lines.push(`Storage: ${formatBytes(stats.storageBytes)}`);
  if (sandbox.lastActivity) lines.push(`Last sandbox activity: ${sandbox.lastActivity}`);
  if (compression.lastActivity) lines.push(`Last compression activity: ${compression.lastActivity}`);
  if (compression.recentSessions.length > 0) {
    lines.push("Recent compressed sessions:");
    for (const session of compression.recentSessions.slice(0, 3)) {
      lines.push(`  - ${session.title}${session.updatedAt ? ` (${session.updatedAt})` : ""}`);
    }
  }
  return lines.join("\n");
}

export function formatSearchResult(result: SearchResult): string {
  if (result.hits.length === 0) {
    const scanned = `sandbox DBs: ${result.diagnostics.contentDbs} content / ${result.diagnostics.sessionDbs} session; compression index: ${result.diagnostics.compressionIndex ? "yes" : "no"}`;
    const scope = result.diagnostics.projectHash ? "current project" : "all projects";
    const errors = result.diagnostics.errors.length > 0 ? `\nErrors:\n- ${result.diagnostics.errors.join("\n- ")}` : "";
    return `No matches for "${result.query}" (${scope}).\nScanned ${scanned}.${errors}`;
  }
  const lines = [`${result.hits.length} match(es) for "${result.query}":`];
  result.hits.forEach((hit, index) => {
    lines.push("");
    lines.push(`${index + 1}. [${hit.layer}/${hit.kind}] ${hit.title}`);
    lines.push(`   ${hit.snippet}`);
    const meta = [`source=${hit.source}`];
    if (hit.ref) meta.push(`ref=${hit.ref}`);
    if (hit.sessionId) meta.push(`session=${hit.sessionId}`);
    if (hit.timestamp) meta.push(`time=${hit.timestamp}`);
    lines.push(`   ${meta.join("  ")}`);
  });
  if (result.diagnostics.errors.length > 0) {
    lines.push("", `Warnings: ${result.diagnostics.errors.join("; ")}`);
  }
  return lines.join("\n");
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const icon = (status: DoctorCheck["status"]): string => (status === "pass" ? "[ok]" : status === "warn" ? "[warn]" : "[fail]");
  const lines = checks.map((check) => {
    const fix = check.fix ? `\n       fix: ${check.fix}` : "";
    return `${icon(check.status)} ${check.title}: ${check.detail}${fix}`;
  });
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  lines.push("", `${checks.length - failed - warned} passed, ${warned} warning(s), ${failed} failure(s).`);
  return lines.join("\n");
}
