#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * GitHub Copilot CLI Stop hook — record session-end state for continuity.
 * Capture-only (emits no output). Parsed via the shared session helpers with
 * COPILOT_OPTS.
 */

import {
  readStdin,
  parseStdin,
  getSessionId,
  getSessionDBPath,
  getInputProjectDir,
  COPILOT_OPTS,
} from "../session-helpers.mjs";
import { createSessionLoaders } from "../session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = COPILOT_OPTS;

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, OPTS);

  const { SessionDB } = await loadSessionDB();
  const dbPath = getSessionDBPath(OPTS, projectDir);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);
  // insertEvent hashes event.data, so type/category/priority/data are all
  // required — a session_end with only `type` throws on createHash(undefined)
  // and is silently dropped (the latent codex/stop.mjs bug). Provide real
  // fields so the session-end row actually persists.
  const lastMessage =
    typeof input.last_assistant_message === "string"
      ? input.last_assistant_message.slice(0, 2000)
      : "";
  db.insertEvent(
    sessionId,
    {
      type: "session_end",
      category: "session",
      priority: 1,
      data: lastMessage || "session ended",
    },
    "Stop",
  );

  db.close();
} catch {
  /* a hook must never fail the host */
}
