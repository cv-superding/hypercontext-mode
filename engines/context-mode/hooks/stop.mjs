#!/usr/bin/env node
import "./suppress-stderr.mjs";
import "./ensure-deps.mjs";
/**
 * Claude Code Stop hook — record turn-end state for continuity.
 *
 * Stop fires when Claude is about to finish the current assistant turn. This is
 * not a true session shutdown event, so record a turn_end marker and never ask
 * Claude to continue.
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir } from "./session-helpers.mjs";
import { createSessionLoaders, attributeAndInsertEvents } from "./session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input);

  const { SessionDB } = await loadSessionDB();
  const dbPath = getSessionDBPath(undefined, projectDir);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input);

  db.ensureSession(sessionId, projectDir);
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

  // ─── claude-code MAIN-turn cost capture (cursor-aware, no double-count) ───
  // The transcript grows every turn and the forward loop forwards ALL passed
  // events, so we emit ONLY the turns NEW since the last Stop, keyed by a
  // per-session high-water cursor. Each step is best-effort — a hook must
  // never block the session, so a transcript read or extract failure here is
  // swallowed without aborting the turn_end write above.
  try {
    const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : null;
    if (transcriptPath) {
      let transcript = null;
      try {
        transcript = readFileSync(transcriptPath, "utf-8");
      } catch {
        // unreadable/missing transcript — skip capture this turn.
      }
      if (transcript) {
        const { extractTranscriptUsageSince } = await loadExtract();
        const { resolveProjectAttributions } = await loadProjectAttribution();
        const cursor = db.getUsageCursor(sessionId);
        const { events, cursor: next } = extractTranscriptUsageSince(transcript, cursor);
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
  // Claude Code hooks must not block the session.
}

process.stdout.write("{}\n");
