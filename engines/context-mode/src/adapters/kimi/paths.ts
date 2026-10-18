import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

export function resolveKimiConfigDir(): string {
  const envVal = process.env.KIMI_CODE_HOME;
  if (envVal) {
    if (envVal.startsWith("~")) {
      return resolve(homedir(), envVal.replace(/^~[/\\]?/, ""));
    }
    return resolve(envVal);
  }
  return resolve(homedir(), ".kimi-code");
}

/**
 * Best-effort resolution of the `<sessionDir>/wire.jsonl` file for a given
 * Kimi Code session id.
 *
 * Ground truth (adapter-matrix/kimi.md): the usage stream is persisted at
 * `<sessionDir>/wire.jsonl` —
 *   refs/platforms/kimi-code/packages/agent-core/src/agent/index.ts:142
 *     new FileSystemAgentRecordPersistence(join(options.homedir, 'wire.jsonl'), ...)
 * where `options.homedir` is the agent's per-session directory.
 *
 * NOTE / WIRE GAP: the exact on-disk mapping from `session_id` → `sessionDir`
 * is NOT carried in the hook stdin payload, and the kimi-code refs are not
 * checked out in this worktree to confirm the session-store directory layout
 * (session/store/session-store.ts:278,316 are cited but unverifiable here). The
 * candidate layouts below cover the documented patterns; this resolver returns
 * the FIRST candidate whose `wire.jsonl` actually exists on disk, else null —
 * so the Stop hook degrades to a no-op rather than guessing wrong. When the
 * refs land, pin the exact layout and drop the fallback list.
 */
export function resolveKimiWireJsonlPath(sessionId: string): string | null {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const configDir = resolveKimiConfigDir();
  const candidates = [
    join(configDir, "sessions", sessionId, "wire.jsonl"),
    join(configDir, "agents", sessionId, "wire.jsonl"),
    join(configDir, sessionId, "wire.jsonl"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // unreadable candidate — try the next.
    }
  }
  return null;
}
