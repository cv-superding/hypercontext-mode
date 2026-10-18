#!/usr/bin/env node
import "./platform.mjs";
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Qwen Code Stop hook — record turn-end state + capture per-turn token cost.
 *
 * Stop fires at the end of an assistant turn, not at true session shutdown, so
 * we record a `turn_end` marker (session_end stays reserved for a genuine
 * terminal lifecycle event) and tail the session JSONL for new usage.
 *
 * COST CAPTURE: qwen-code's hook stdin carries tool I/O ONLY — token usage is
 * unreachable through the hook stream (matrix §4). The single live capture path
 * is a cursor-gated tail of the session record file at
 *   ~/.qwen/tmp/<project_id>/chats/<sessionId>.jsonl
 * where <project_id> = sha256(projectRoot) hex
 * (refs chatRecordingService.ts:451 + storage.ts:316-320 getProjectTempDir;
 * paths.ts:262 getProjectHash). The extractor lives in
 * src/adapters/qwen-code/usage.ts and is re-exported through the
 * session-extract bundle (src/session/extract.ts), reachable here via
 * loadExtract() — exactly the kimi wire.jsonl pattern.
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir } from "../session-helpers.mjs";
import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);

// Qwen Code session options. Mirrors the QwenCodeAdapter config (index.ts):
// config dir ~/.qwen, project dir via QWEN_PROJECT_DIR (no config-dir env var,
// no session-id env var — session_id arrives on the hook stdin). Kept local
// because session-helpers.mjs ships no QWEN_OPTS export.
const QWEN_OPTS = {
  configDir: ".qwen",
  configDirEnv: undefined,
  projectDirEnv: "QWEN_PROJECT_DIR",
  sessionIdEnv: undefined,
};

/**
 * Resolve the qwen config dir (~/.qwen). Qwen Code exposes no documented
 * config-dir override env var (unlike CODEX_HOME / KIMI_CODE_HOME), so this is
 * a fixed home-rooted path. NO regex.
 */
function resolveQwenHome() {
  return resolve(homedir(), ".qwen");
}

/**
 * EXACT port of qwen's getProjectHash (paths.ts:262): sha256 hex of the project
 * root, lowercased first on win32 for case-insensitive FS parity. The TS twin
 * is `qwenProjectHash` in src/adapters/qwen-code/usage.ts (unit-tested); the
 * hook cannot import that TS at runtime, so the logic is duplicated here — same
 * precedent as kimi's resolveKimiConfigDir. NO regex.
 */
function qwenProjectHash(projectRoot) {
  const normalized = platform() === "win32" ? String(projectRoot).toLowerCase() : String(projectRoot);
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Resolve <qwenHome>/tmp/<sha256(projectRoot)>/chats/<sessionId>.jsonl.
 *
 * Primary path is fully deterministic from the hashing scheme above. Should the
 * hash diverge (e.g. an upstream qwen normalization we did not pin), we fall
 * back to a glob of every <qwenHome>/tmp/<*>/chats dir for <sessionId>.jsonl —
 * a pure directory walk + filename equality test, NO regex. Best-effort:
 * returns null on any failure so cost capture never blocks the turn.
 */
function resolveQwenChatJsonlPath(projectDir, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const qwenHome = resolveQwenHome();
  const fileName = `${sessionId}.jsonl`;

  // 1) Canonical hashed path.
  try {
    if (typeof projectDir === "string" && projectDir.length > 0) {
      const direct = join(qwenHome, "tmp", qwenProjectHash(projectDir), "chats", fileName);
      if (existsSync(direct)) return direct;
    }
  } catch { /* fall through to glob */ }

  // 2) Glob fallback — scan every tmp/<hash>/chats for this session file.
  try {
    const tmpRoot = join(qwenHome, "tmp");
    if (!existsSync(tmpRoot)) return null;
    let projectDirs;
    try { projectDirs = readdirSync(tmpRoot, { withFileTypes: true }); } catch { return null; }
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const candidate = join(tmpRoot, entry.name, "chats", fileName);
      try { if (existsSync(candidate)) return candidate; } catch { /* try next */ }
    }
  } catch { /* best-effort */ }

  return null;
}

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, QWEN_OPTS);

  const { SessionDB } = await loadSessionDB();
  const dbPath = getSessionDBPath(QWEN_OPTS, projectDir);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, QWEN_OPTS);

  db.ensureSession(sessionId, projectDir);
  // SessionEvent contract requires {type, category, data, priority}. insertEvent
  // hashes `data` for the dedup key, so encode the turn snapshot into `data`.
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

  // ─── qwen-code per-turn cost capture (cursor-gated, no double-count) ───
  // Usage lives ONLY on the session chats JSONL ChatRecords, never in hook
  // stdin. Tail the file, sum NEW usage records since a per-session high-water
  // cursor, and forward. Best-effort — a missing file or read/extract failure
  // must never block the turn_end write or the session, so the whole block is
  // wrapped and swallowed.
  try {
    const jsonlPath = resolveQwenChatJsonlPath(projectDir, sessionId);
    if (jsonlPath) {
      let jsonlText = null;
      try {
        jsonlText = readFileSync(jsonlPath, "utf-8");
      } catch {
        // unreadable/missing chats JSONL — skip capture this turn.
      }
      if (jsonlText) {
        const { extractQwenUsageSince } = await loadExtract();
        const { resolveProjectAttributions } = await loadProjectAttribution();
        const cursor = db.getUsageCursor(sessionId);
        const { events, cursor: next } = extractQwenUsageSince(jsonlText, cursor);
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
  // Qwen Code hooks must not block the session.
}

process.stdout.write("{}\n");
