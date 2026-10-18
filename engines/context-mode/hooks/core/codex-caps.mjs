/**
 * Codex capability detection for the PreToolUse formatter (#845).
 *
 * Recent Codex builds honor PreToolUse `permissionDecision:"allow" + updatedInput`
 * (command rewrite) and `additionalContext`. Older builds reject/ignore those
 * fields. context-mode must emit the rewrite shape ONLY when the running Codex
 * supports it and otherwise fail closed (deny) — it must never silently pass a
 * redirect through.
 *
 * Detection parses `codex --version` and compares it against the first version
 * verified to honor the contract. The result is cached to a temp file with a
 * short TTL so the hot PreToolUse path does not spawn a process on every tool
 * call. Any failure (no codex on PATH, parse error) → false → fail closed.
 *
 * There is intentionally NO opt-in env flag — those rot into dead code because
 * nobody exercises the off-by-default path. The correct behavior is detected at
 * runtime so it is always the default.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * First Codex release verified to honor PreToolUse allow+updatedInput and
 * additionalContext: codex-cli 0.141.0 (#845, validated against the shipped
 * binary's output_parser). Below this we fail closed.
 */
export const MIN_REWRITE_VERSION = [0, 141, 0];

const CACHE_TTL_MS = 60 * 60 * 1000; // re-probe at most hourly
const CACHE_FILE = "context-mode-codex-caps.json";

/** Parse a `codex --version` line ("codex-cli 0.141.0") → [major, minor, patch]. */
export function parseCodexVersion(raw) {
  const s = String(raw ?? "");
  const isDigit = (c) => c >= "0" && c <= "9";
  for (let i = 0; i < s.length; i++) {
    let j = i;
    const parts = [];
    while (parts.length < 3) {
      const start = j;
      while (j < s.length && isDigit(s[j])) j++;
      if (j === start) break; // no digits where a number was expected
      parts.push(Number(s.slice(start, j)));
      if (parts.length < 3) {
        if (s[j] !== ".") break; // separator must be a dot
        j++;
      }
    }
    if (parts.length === 3) return parts;
  }
  return null;
}

/** Semantic ">=" over [major, minor, patch] tuples. */
export function versionGte(a, b) {
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function defaultRunVersion() {
  const opts = { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] };
  // Mirror the adapter's cross-platform probe (src/adapters/codex/index.ts):
  // on Windows `codex` resolves to a .cmd shim that execFile cannot launch
  // directly, so route through cmd.exe.
  return process.platform === "win32"
    ? execFileSync("cmd.exe", ["/d", "/s", "/c", "codex --version"], opts)
    : execFileSync("codex", ["--version"], opts);
}

/**
 * Whether the running Codex honors PreToolUse allow+updatedInput /
 * additionalContext. Fails closed (false) on any error. Cached to a temp file
 * with a TTL so the hot path avoids per-call process spawns.
 *
 * @param {object} [io] test seams
 * @param {() => string} [io.runVersion] returns `codex --version` stdout
 * @param {() => number}  [io.now]        clock in ms
 * @param {string}        [io.cachePath]  cache file path
 * @returns {boolean}
 */
export function codexSupportsUpdatedInput(io = {}) {
  const now = io.now ?? Date.now;
  const cachePath = io.cachePath ?? join(tmpdir(), CACHE_FILE);
  const runVersion = io.runVersion ?? defaultRunVersion;

  // Fast path: a non-expired cache entry.
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (cached && typeof cached.at === "number" && now() - cached.at < CACHE_TTL_MS) {
      return cached.supported === true;
    }
  } catch { /* cache miss / corrupt — re-detect below */ }

  let supported = false;
  try {
    const version = parseCodexVersion(runVersion());
    supported = version ? versionGte(version, MIN_REWRITE_VERSION) : false;
  } catch {
    supported = false; // no codex on PATH / probe failed → fail closed
  }

  try { writeFileSync(cachePath, JSON.stringify({ at: now(), supported })); } catch { /* best effort */ }

  return supported;
}
