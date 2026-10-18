#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";

import { createSessionLoaders } from "../session-loaders.mjs";
import { createRoutingBlock } from "../routing-block.mjs";
import { createToolNamer } from "../core/tool-naming.mjs";
import { writeSessionEventsFile, buildSessionDirective, getSessionEvents } from "../session-directive.mjs";
import {
  readStdin,
  parseStdin,
  getSessionId,
  getSessionDBPath,
  getSessionEventsPath,
  getCleanupFlagPath,
  getInputProjectDir,
  COPILOT_OPTS,
  resolveConfigDir,
} from "../session-helpers.mjs";
import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const toolNamer = createToolNamer("copilot-cli");
const ROUTING_BLOCK = createRoutingBlock(toolNamer);
const HOOK_DIR = fileURLToPath(new URL(".", import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = COPILOT_OPTS;

let additionalContext = ROUTING_BLOCK;

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const source = input.source ?? "startup";
  const projectDir = getInputProjectDir(input, OPTS);

  if (source === "compact") {
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input, OPTS);
    const resume = db.getResume(sessionId);

    if (resume && !resume.consumed) {
      db.markResumeConsumed(sessionId);
    }

    const events = getSessionEvents(db, sessionId);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath(OPTS, projectDir));
      additionalContext += buildSessionDirective("compact", eventMeta, toolNamer);
    }

    db.close();
  } else if (source === "resume") {
    try { unlinkSync(getCleanupFlagPath(OPTS, projectDir)); } catch { /* no flag */ }

    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });

    const sessionId = getSessionId(input, OPTS);
    const events = sessionId ? getSessionEvents(db, sessionId) : [];
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath(OPTS, projectDir));
      additionalContext += buildSessionDirective("resume", eventMeta, toolNamer);
    }

    db.close();
  } else if (source === "startup" || source === "new") {
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });
    try { unlinkSync(getSessionEventsPath(OPTS, projectDir)); } catch { /* no stale file */ }

    db.cleanupOldSessions(7);
    db.db.exec(`DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)`);

    const sessionId = getSessionId(input, OPTS);
    db.ensureSession(sessionId, projectDir);

    const ruleFilePaths = [
      join(projectDir, ".github", "copilot-instructions.md"),
      join(projectDir, "AGENTS.md"),
    ];
    for (const p of ruleFilePaths) {
      try {
        const content = readFileSync(p, "utf-8");
        if (content.trim()) {
          db.insertEvent(sessionId, { type: "rule", category: "rule", data: p, priority: 1 });
          db.insertEvent(sessionId, { type: "rule_content", category: "rule", data: content, priority: 1 });
        }
      } catch {
        /* file does not exist - skip */
      }
    }

    db.close();
  }
} catch (err) {
  // Error telemetry is opt-in via CONTEXT_MODE_DEBUG (same pattern as the kimi
  // hooks) so we don't write an append-only log to every user's config dir on a
  // transient SessionStart error. See #787 review.
  if (process.env.CONTEXT_MODE_DEBUG) {
    try {
      const { appendFileSync, mkdirSync } = await import("node:fs");
      const { join: pjoin, dirname: pdirname } = await import("node:path");
      const logPath = pjoin(resolveConfigDir(OPTS), "context-mode", "sessionstart-debug.log");
      mkdirSync(pdirname(logPath), { recursive: true });
      appendFileSync(
        logPath,
        `[${new Date().toISOString()}] ${err?.message || err}\n${err?.stack || ""}\n`,
      );
    } catch {
      /* ignore logging failure */
    }
  }
}

console.log(JSON.stringify({ additionalContext }));
