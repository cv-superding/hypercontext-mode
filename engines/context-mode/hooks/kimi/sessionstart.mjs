#!/usr/bin/env node
import "./platform.mjs";
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Kimi Code CLI sessionStart hook for context-mode.
 */

import { createRoutingBlock } from "../routing-block.mjs";
import { createToolNamer } from "../core/tool-naming.mjs";

const toolNamer = createToolNamer("kimi");
const ROUTING_BLOCK = createRoutingBlock(toolNamer);
import {
  writeSessionEventsFile,
  buildSessionDirective,
  getSessionEvents,
} from "../session-directive.mjs";
import {
  readStdin,
  parseStdin,
  getSessionId,
  getSessionDBPath,
  getSessionEventsPath,
  getCleanupFlagPath,
  getInputProjectDir,
  resolveConfigDir,
  KIMI_OPTS,
} from "../session-helpers.mjs";
import { createSessionLoaders } from "../session-loaders.mjs";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = fileURLToPath(new URL(".", import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = KIMI_OPTS;

let additionalContext = ROUTING_BLOCK;

function captureKimiInstructionRules(db, sessionId, projectDir) {
  const paths = [];
  for (const baseDir of [resolveConfigDir(OPTS), projectDir]) {
    paths.push(join(baseDir, "AGENTS.md"));
    paths.push(join(baseDir, "AGENTS.override.md"));
  }

  for (const p of [...new Set(paths)]) {
    try {
      if (!existsSync(p)) continue;
      const content = readFileSync(p, "utf8");
      db.insertEvent(sessionId, { type: "rule", category: "rule", data: p, priority: 1 });
      db.insertEvent(sessionId, { type: "rule_content", category: "rule", data: content, priority: 1 });
    } catch {
      // Missing or unreadable rule files should never break SessionStart.
    }
  }
}

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  // Kimi Code emits ONLY 'startup' | 'resume' for SessionStart.source:
  //   refs/platforms/kimi-code/.../session/index.ts:153,181,495
  //     (triggerSessionStart signature is `source: 'startup' | 'resume'`)
  //   refs/platforms/kimi-cli/src/kimi_cli/cli/__init__.py:642
  //     (`_session_source = "resume" if resumed else "startup"`)
  // Default unknown values to 'startup' rather than branching on a
  // 'compact' path that the host never reaches.
  const source = input.source === "resume" ? "resume" : "startup";
  const projectDir = getInputProjectDir(input, KIMI_OPTS);

  if (source === "resume") {
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input, OPTS);

    try { unlinkSync(getCleanupFlagPath(OPTS, projectDir)); } catch { /* no flag */ }

    const events = sessionId ? getSessionEvents(db, sessionId) : [];
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath(OPTS, projectDir));
      additionalContext += buildSessionDirective(source, eventMeta, toolNamer);
    }

    db.close();
  } else {
    // source === "startup"
    const { SessionDB } = await loadSessionDB();
    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });
    try { unlinkSync(getSessionEventsPath(OPTS, projectDir)); } catch { /* no stale file */ }

    db.cleanupOldSessions(7);
    // Single source of truth lives in SessionDB. Reaching through `db.db.exec`
    // duplicated schema knowledge in the hook and would silently drift if
    // `session_events` ever renamed its FK column.
    db.pruneOrphanedEvents();

    const sessionId = getSessionId(input, OPTS);
    db.ensureSession(sessionId, projectDir);
    captureKimiInstructionRules(db, sessionId, projectDir);

    db.close();
  }
} catch {
  // Swallow errors — hook must not fail
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
}) + "\n");
