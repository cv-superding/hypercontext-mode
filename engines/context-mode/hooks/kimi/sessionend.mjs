#!/usr/bin/env node
import "./platform.mjs";
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Kimi Code CLI SessionEnd hook — record genuine session close.
 *
 * Wired to the upstream `SessionEnd` event, distinct from `Stop`:
 *   refs/platforms/kimi-code/packages/agent-core/src/session/index.ts:
 *     192  — `await this.triggerSessionEnd('exit')` inside `close()`
 *     502  — `triggerSessionEnd(reason: 'exit')` signature
 *     11   — `'SessionEnd'` in `HOOK_EVENT_TYPES` (types.ts)
 *   refs/platforms/kimi-cli/src/kimi_cli/hooks/events.py:108-114 — Python
 *     runtime emits `session_end(session_id, cwd, reason)` independently
 *     of `Stop`.
 *
 * Stop fires at the end of every assistant turn — writing a `session_end`
 * SessionDB row from Stop produced one such row per turn. SessionEnd
 * fires once when the host's session closes, which is what consumers of
 * `type === "session_end"` (analytics, resume) actually mean.
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir, KIMI_OPTS } from "../session-helpers.mjs";
import { createSessionLoaders } from "../session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = KIMI_OPTS;

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
  // `data`, `priority`. Encode the payload — including `reason`, which
  // upstream currently only emits as `'exit'` but is typed as a free string
  // for forward compatibility — into `data` so dedup-hashing succeeds and
  // the row lands.
  const reason = typeof input.reason === "string" ? input.reason : "exit";
  db.insertEvent(sessionId, {
    type: "session_end",
    category: "session",
    data: JSON.stringify({ status: "completed", reason }),
    priority: 1,
  }, "SessionEnd");

  db.close();
} catch {
  // Kimi Code hooks must not block session shutdown.
}

process.stdout.write("{}\n");
