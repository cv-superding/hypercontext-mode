#!/usr/bin/env node
import "./platform.mjs";
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Kimi Code CLI postToolUse hook — session event capture.
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir, KIMI_OPTS } from "../session-helpers.mjs";
import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = KIMI_OPTS;

function normalizeToolName(toolName) {
  if (toolName === "Shell") return "Bash";
  return toolName;
}

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, OPTS);

  const { extractEvents } = await loadExtract();
  const { resolveProjectAttributions } = await loadProjectAttribution();
  const { SessionDB } = await loadSessionDB();

  const dbPath = getSessionDBPath(OPTS, projectDir);
  const db = new SessionDB({ dbPath });
  const sessionId = getSessionId(input, OPTS);

  db.ensureSession(sessionId, projectDir);

  // Kimi Code sends tool_output on success (no tool_response field).
  // Normalize tool_response to a clean string — when the host omits it,
  // surface the empty string rather than `JSON.stringify(undefined ?? "")`
  // which yields `'""'` and tricks downstream extractEvents into treating
  // an empty response as a non-empty payload.
  let toolResponse = "";
  if (typeof input.tool_response === "string") {
    toolResponse = input.tool_response;
  } else if (input.tool_response !== undefined && input.tool_response !== null) {
    toolResponse = JSON.stringify(input.tool_response);
  }
  const normalizedInput = {
    tool_name: normalizeToolName(input.tool_name ?? ""),
    tool_input: input.tool_input ?? {},
    tool_response: toolResponse,
    tool_output: input.tool_output
      ? {
        ...input.tool_output,
        isError: input.tool_output.isError === true || input.tool_output.is_error === true,
      }
      : undefined,
  };

  const events = extractEvents(normalizedInput);

  attributeAndInsertEvents(db, sessionId, events, input, projectDir, "PostToolUse", resolveProjectAttributions);

  db.close();
} catch {
  // Swallow errors — hook must not fail
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "" },
}) + "\n");
