#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Antigravity CLI (`agy`) Stop hook — session-end capture.
 *
 * agy's verified hook list exposes `Stop` ("when agent tries to exit") and no
 * separate SessionEnd hook, so this records a single session_end marker when
 * agy emits it. `agy -p` probes have not emitted Stop, so registration is
 * best-effort. The hook is capture-only and emits no stdout.
 */

import {
  readStdin,
  getSessionId,
  getSessionDBPath,
  getInputProjectDir,
  ANTIGRAVITY_CLI_OPTS,
} from "../session-helpers.mjs";
import { createSessionLoaders } from "../session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fromAgy, parseAgyPayload } from "./payload.mjs";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB } = createSessionLoaders(HOOK_DIR);
const OPTS = ANTIGRAVITY_CLI_OPTS;

try {
  const payload = parseAgyPayload(await readStdin());
  const input = fromAgy(payload);
  const projectDir = getInputProjectDir(input, OPTS);

  const { SessionDB } = await loadSessionDB();
  const dbPath = getSessionDBPath(OPTS, projectDir);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);
  db.insertEvent(
    sessionId,
    {
      type: "session_end",
      category: "session",
      priority: 1,
      data: JSON.stringify({
        status: payload?.status ?? "stopped",
        stepIdx: payload?.stepIdx ?? null,
        transcriptPath: payload?.transcriptPath ?? null,
      }),
    },
    "Stop",
  );

  db.close();
} catch {
  // A hook must never fail the host agent.
}
