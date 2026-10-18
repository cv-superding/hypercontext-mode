#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Antigravity CLI (`agy`) PostToolUse hook — session event capture.
 *
 * agy fires hooks from a config at ~/.gemini/config/hooks.json (or via an
 * installed agy plugin's hooks/hooks.json) and pipes a payload whose shape
 * differs from the Claude-Code/Codex wire format this pipeline expects:
 *
 *   { conversationId, stepIdx, toolCall: { name, args }, error,
 *     workspacePaths: [..], transcriptPath, artifactDirectoryPath }
 *
 * The event name arrives as argv (set in hooks.json), NOT in the payload, and
 * the hook CWD is ~/.gemini/config — so the project dir MUST come from
 * workspacePaths[0], never process.cwd(). We translate agy's payload into the
 * Claude-shaped `input` the shared extractor/attribution pipeline consumes,
 * then reuse it unchanged. This hook is capture-only and emits no stdout.
 */

import {
  readStdin,
  getSessionId,
  getSessionDBPath,
  getInputProjectDir,
  ANTIGRAVITY_CLI_OPTS,
} from "../session-helpers.mjs";
import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fromAgy, parseAgyPayload } from "./payload.mjs";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = ANTIGRAVITY_CLI_OPTS;

try {
  const input = fromAgy(parseAgyPayload(await readStdin()));

  if (input.tool_name) {
    const projectDir = getInputProjectDir(input, OPTS);

    const { extractEvents } = await loadExtract();
    const { resolveProjectAttributions } = await loadProjectAttribution();
    const { SessionDB } = await loadSessionDB();

    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input, OPTS);

    db.ensureSession(sessionId, projectDir);

    const normalizedInput = {
      tool_name: input.tool_name,
      tool_input: input.tool_input ?? {},
      tool_response: input.tool_response ?? "",
      tool_output: input.tool_output,
    };

    const events = extractEvents(normalizedInput);
    attributeAndInsertEvents(db, sessionId, events, input, projectDir, "PostToolUse", resolveProjectAttributions);

    try {
      const rejectedPath = resolve(tmpdir(), `context-mode-rejected-${sessionId}.txt`);
      let rejectedData;
      try {
        rejectedData = readFileSync(rejectedPath, "utf-8").trim();
        unlinkSync(rejectedPath);
      } catch { /* no marker */ }
      if (rejectedData) {
        const colonIdx = rejectedData.indexOf(":");
        const rejTool = colonIdx > 0 ? rejectedData.slice(0, colonIdx) : rejectedData;
        const rejReason = colonIdx > 0 ? rejectedData.slice(colonIdx + 1) : "denied";
        attributeAndInsertEvents(
          db,
          sessionId,
          [{
            type: "rejected",
            category: "rejected-approach",
            data: `${rejTool}: ${rejReason}`,
            priority: 2,
          }],
          input,
          projectDir,
          "PreToolUse",
          resolveProjectAttributions,
        );
      }
    } catch { /* best-effort */ }

    try {
      const redirectPath = resolve(tmpdir(), `context-mode-redirect-${sessionId}.txt`);
      let redirectData;
      try {
        redirectData = readFileSync(redirectPath, "utf-8").trim();
        unlinkSync(redirectPath);
      } catch { /* no marker */ }

      if (redirectData) {
        const i1 = redirectData.indexOf(":");
        const i2 = i1 >= 0 ? redirectData.indexOf(":", i1 + 1) : -1;
        const i3 = i2 >= 0 ? redirectData.indexOf(":", i2 + 1) : -1;
        if (i1 > 0 && i2 > i1 && i3 > i2) {
          const tool = redirectData.slice(0, i1);
          const type = redirectData.slice(i1 + 1, i2);
          const bytesRaw = redirectData.slice(i2 + 1, i3);
          const summary = redirectData.slice(i3 + 1);
          const bytesAvoided = Number.parseInt(bytesRaw, 10);
          if (Number.isFinite(bytesAvoided) && bytesAvoided > 0) {
            attributeAndInsertEvents(
              db,
              sessionId,
              [{
                type,
                category: "redirect",
                data: `${tool}: ${summary}`,
                priority: 2,
                bytes_avoided: bytesAvoided,
              }],
              input,
              projectDir,
              "PreToolUse",
              resolveProjectAttributions,
            );
          }
        }
      }
    } catch { /* best-effort */ }

    db.close();
  }
} catch {
  // Swallow errors — a hook must never fail the host agent.
}

// Capture-only hook: emit nothing.
