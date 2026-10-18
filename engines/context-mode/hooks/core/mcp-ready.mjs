/**
 * MCP readiness sentinel — checks if MCP server has started.
 *
 * Server writes sentinel (containing its PID) after connect().
 * Hooks scan for any live sentinel to detect MCP readiness.
 *
 * Fix for #347: Claude Code spawns hooks via `bash -c "node ..."` on Linux/WSL2.
 * The intermediate shell makes process.ppid point to a transient bash PID, not
 * Claude Code. Directory-scan + PID liveness probe works regardless of spawn topology.
 *
 * Sentinel path: <tmpRoot>/context-mode-mcp-ready-<MCP_PID>
 * Scan: glob all context-mode-mcp-ready-* files, probe each PID.
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SENTINEL_PREFIX = "context-mode-mcp-ready-";

/**
 * Sentinel freshness window (#844). The MCP server refreshes its sentinel's
 * mtime every 30s while alive (see `main()` in src/server.ts). A sentinel
 * touched within this window is treated as a live server even when
 * `process.kill(pid, 0)` cannot see the PID — e.g. a sandbox sharing /tmp
 * across an isolated PID namespace, where the live host PID is invisible.
 * 90s = 3x the server refresh interval, tolerant of scheduler jitter / load.
 */
const SENTINEL_FRESH_MS = 90_000;

/**
 * Resolve the temp root — hardcoded /tmp on Unix to avoid TMPDIR mismatch.
 * Tests may override via CONTEXT_MODE_MCP_SENTINEL_DIR to isolate scan from
 * leftover sentinels in the real /tmp.
 */
export function sentinelDir() {
  const override = process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
  if (override && override.length > 0) return override;
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

/**
 * Build sentinel path for a given PID.
 * Used by server.ts to write its own sentinel.
 */
export function sentinelPathForPid(pid) {
  return join(sentinelDir(), `${SENTINEL_PREFIX}${pid}`);
}

/**
 * @deprecated Use sentinelPathForPid(process.pid) from server.ts.
 * Kept for backward compat during migration — tests that still
 * write sentinels with process.ppid will work for one release cycle.
 */
export function sentinelPath() {
  return join(sentinelDir(), `${SENTINEL_PREFIX}${process.ppid}`);
}

/**
 * Check if any MCP server is alive by scanning sentinel files.
 *
 * Scans sentinelDir() for context-mode-mcp-ready-* files, reads the PID
 * from each, and probes with kill(pid, 0). Cleans up stale sentinels
 * from crashed servers.
 *
 * Handles:
 * - PPID mismatch (WSL2 shell wrappers) — no ppid dependency
 * - Stale sentinels (SIGKILL, OOM) — PID liveness check + age threshold
 * - TMPDIR mismatch — hardcoded /tmp on Unix
 * - Shared /tmp across isolated PID namespaces (#844) — a live host PID is
 *   invisible to `kill(pid, 0)` from a sandbox, so a recently-refreshed
 *   sentinel is trusted instead of being deleted.
 */
export function isMCPReady() {
  try {
    const dir = sentinelDir();
    const files = readdirSync(dir).filter(f => f.startsWith(SENTINEL_PREFIX));
    const now = Date.now();
    for (const f of files) {
      const fullPath = join(dir, f);
      let pid;
      try {
        pid = parseInt(readFileSync(fullPath, "utf8"), 10);
      } catch {
        // Unreadable (torn mid-write) — leave it for the owner / a later scan.
        continue;
      }
      if (isNaN(pid)) continue;
      try {
        process.kill(pid, 0); // throws if the PID is not signalable from here
        return true;          // same-namespace liveness confirmed
      } catch (err) {
        // EPERM: the process exists but is owned by another user → alive.
        if (err && err.code === "EPERM") return true;
        // ESRCH (or anything else): the PID is invisible from THIS namespace.
        // That is NOT proof the server is dead — a shared /tmp across isolated
        // PID namespaces (#844) hides a live host PID. Trust a recently
        // refreshed sentinel rather than delete a live server's marker.
        let ageMs = Infinity;
        try { ageMs = now - statSync(fullPath).mtimeMs; } catch { /* stat failed → treat as stale */ }
        if (ageMs < SENTINEL_FRESH_MS) return true;
        // Old AND unprobeable → genuinely stale (crash / OOM / SIGKILL) → clean up.
        try { unlinkSync(fullPath); } catch { /* best effort */ }
      }
    }
    return false;
  } catch {
    return false;
  }
}
