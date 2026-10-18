#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";

import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import {
  readStdin,
  parseStdin,
  getSessionId,
  getSessionDBPath,
  getInputProjectDir,
  COPILOT_OPTS,
  resolveConfigDir,
} from "../session-helpers.mjs";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = COPILOT_OPTS;
// Diagnostic log is opt-in via CONTEXT_MODE_DEBUG. PostToolUse fires on every
// tool call, so an unconditional append-only log grows without bound under the
// user's config dir. Gate it behind the env flag — same pattern as the kimi
// hooks — so contributors can still capture it on demand. See #787 review.
const DEBUG_LOG = process.env.CONTEXT_MODE_DEBUG
  ? join(resolveConfigDir(OPTS), "context-mode", "posttooluse-debug.log")
  : null;

function logDebug(line) {
  if (!DEBUG_LOG) return;
  try {
    mkdirSync(dirname(DEBUG_LOG), { recursive: true });
    appendFileSync(DEBUG_LOG, line);
  } catch {
    /* silent */
  }
}

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, OPTS);
  const toolName = input.tool_name ?? input.toolName ?? "";
  const toolInput = input.tool_input ?? input.toolArgs ?? {};
  const toolResponse =
    input.tool_result?.text_result_for_llm ??
    input.toolResult?.textResultForLlm ??
    input.tool_response ??
    input.toolResult;

  logDebug(`[${new Date().toISOString()}] CALL: ${toolName}\n`);

  const { extractEvents } = await loadExtract();
  const { resolveProjectAttributions } = await loadProjectAttribution();
  const { SessionDB } = await loadSessionDB();

  const dbPath = getSessionDBPath(OPTS, projectDir);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);

  const events = extractEvents({
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: typeof toolResponse === "string"
      ? toolResponse
      : JSON.stringify(toolResponse ?? ""),
    tool_output: input.tool_output,
  });

  attributeAndInsertEvents(db, sessionId, events, input, projectDir, "PostToolUse", resolveProjectAttributions);

  logDebug(`[${new Date().toISOString()}] OK: ${toolName} -> ${events.length} events\n`);
  db.close();
} catch (err) {
  logDebug(`[${new Date().toISOString()}] ERR: ${err?.message || err}\n`);
}
