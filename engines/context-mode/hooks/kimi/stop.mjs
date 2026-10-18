#!/usr/bin/env node
import "./platform.mjs";
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Kimi Code CLI Stop hook — record turn-end state for continuity.
 *
 * Stop fires at the END OF EACH ASSISTANT TURN, not at session close.
 * Kimi Code emits a distinct `SessionEnd` event for genuine session
 * shutdown (refs/platforms/kimi-code/.../session/index.ts:192,502 —
 * `triggerSessionEnd('exit')`); the matching `hooks/kimi/sessionend.mjs`
 * owns the `session_end` SessionDB row. Writing `session_end` here would
 * have produced one such row per turn.
 *   Cross-reference: refs/platforms/kimi-cli/src/kimi_cli/hooks/events.py:
 *     99-114 — `session_start` and `session_end` are distinct emitters.
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir, KIMI_OPTS } from "../session-helpers.mjs";
import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = KIMI_OPTS;

/**
 * Resolve <kimiConfigDir> (mirrors src/adapters/kimi/paths.ts:resolveKimiConfigDir
 * — hooks cannot import the TS module, so the logic is duplicated here).
 */
function resolveKimiConfigDir() {
  const envVal = process.env.KIMI_CODE_HOME;
  if (envVal) {
    if (envVal.startsWith("~")) return resolve(homedir(), envVal.replace(/^~[/\\]?/, ""));
    return resolve(envVal);
  }
  return resolve(homedir(), ".kimi-code");
}

/**
 * Best-effort <sessionDir>/wire.jsonl resolution keyed by session id.
 *
 * NOTE / WIRE GAP: adapter-matrix/kimi.md confirms usage lands at
 * <sessionDir>/wire.jsonl (agent/index.ts:142), but the exact session_id ->
 * sessionDir directory layout is not carried in the hook stdin payload and the
 * kimi-code refs are not checked out in this worktree to pin it. We probe the
 * documented candidate layouts and return the first whose wire.jsonl exists,
 * else null -> the cost block degrades to a no-op rather than guessing wrong.
 */
function resolveKimiWireJsonlPath(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const configDir = resolveKimiConfigDir();
  const candidates = [
    join(configDir, "sessions", sessionId, "wire.jsonl"),
    join(configDir, "agents", sessionId, "wire.jsonl"),
    join(configDir, sessionId, "wire.jsonl"),
  ];
  for (const candidate of candidates) {
    try { if (existsSync(candidate)) return candidate; } catch { /* try next */ }
  }
  return null;
}

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, OPTS);

  const { SessionDB } = await loadSessionDB();
  const dbPath = getSessionDBPath(OPTS, projectDir);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);
  // SessionEvent contract (src/types.ts:33-47) requires `type`, `category`,
  // `data`, `priority`. SessionDB.insertEvent hashes `event.data` for the
  // dedup key — passing `undefined` throws inside the wrapping try and the
  // row silently never lands. Encode the turn snapshot into `data` so the
  // hash is stable and the row actually persists.
  const payload = {
    stop_hook_active: input.stop_hook_active ?? false,
    last_assistant_message: typeof input.last_assistant_message === "string"
      ? input.last_assistant_message.slice(0, 2000)
      : null,
  };
  db.insertEvent(sessionId, {
    type: "turn_end",
    category: "session",
    data: JSON.stringify(payload),
    priority: 1,
  }, "Stop");

  // ─── kimi-code per-turn cost capture (cursor-gated, no double-count) ───
  // Usage lives ONLY on <sessionDir>/wire.jsonl `usage.record` lines, never in
  // hook stdin (adapter-matrix/kimi.md). Tail the file, sum NEW delta lines
  // since a per-session high-water cursor, and forward. Best-effort — a missing
  // wire file or read/extract failure must never block the turn_end write or
  // the session, so the whole block is wrapped and swallowed.
  try {
    const wirePath = resolveKimiWireJsonlPath(sessionId);
    if (wirePath) {
      let wireText = null;
      try {
        wireText = readFileSync(wirePath, "utf-8");
      } catch {
        // unreadable/missing wire.jsonl — skip capture this turn.
      }
      if (wireText) {
        const { extractKimiUsageSince } = await loadExtract();
        const { resolveProjectAttributions } = await loadProjectAttribution();
        const cursor = db.getUsageCursor(sessionId);
        const { events, cursor: next } = extractKimiUsageSince(wireText, cursor);
        if (events.length > 0) {
          // attributeAndInsertEvents both INSERTS locally and FORWARDS to the
          // platform (gated on ~/.context-mode/platform.json).
          attributeAndInsertEvents(db, sessionId, events, input, projectDir, "Stop", resolveProjectAttributions);
        }
        if (next) db.setUsageCursor(sessionId, next);
      }
    }
  } catch {
    // Best-effort cost capture — never block the session on failure.
  }

  db.close();
} catch {
  // Kimi Code hooks must not block the session.
}

process.stdout.write("{}\n");
