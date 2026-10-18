#!/usr/bin/env node
import "./platform.mjs";
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Kimi Code CLI UserPromptSubmit hook — capture user prompts for continuity.
 *
 * Kimi Code sends `prompt` as a ContentPart[] array. We normalize it to
 * a single string so downstream extractors work correctly.
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir, KIMI_OPTS } from "../session-helpers.mjs";
import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = KIMI_OPTS;

function extractPromptText(input) {
  const raw = input.prompt ?? input.message ?? "";
  if (Array.isArray(raw)) {
    // ContentPart[] — Kimi Code sends { type: "text", text: "..." } objects
    return raw
      .filter((p) => p && (p.type === "text" || typeof p.text === "string"))
      .map((p) => p.text)
      .join("\n");
  }
  return String(raw);
}

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, OPTS);

  const prompt = extractPromptText(input);
  const trimmed = (prompt || "").trim();

  const isSystemMessage = trimmed.startsWith("<task-notification>")
    || trimmed.startsWith("<system-reminder>")
    || trimmed.startsWith("<context_guidance>")
    || trimmed.startsWith("<tool-result>");

  if (trimmed.length > 0 && !isSystemMessage) {
    const { SessionDB } = await loadSessionDB();
    const { extractUserEvents } = await loadExtract();
    const { resolveProjectAttributions } = await loadProjectAttribution();
    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input, OPTS);

    db.ensureSession(sessionId, projectDir);

    const promptEvent = {
      type: "user_prompt",
      category: "user-prompt",
      data: prompt,
      priority: 1,
    };
    const promptAttributions = attributeAndInsertEvents(
      db, sessionId, [promptEvent], input, projectDir, "UserPromptSubmit", resolveProjectAttributions,
    );

    const userEvents = extractUserEvents(trimmed);
    const savedLastKnown = promptAttributions[0]?.projectDir || null;
    const sessionStats = db.getSessionStats(sessionId);
    const lastKnownProjectDir = typeof db.getLatestAttributedProjectDir === "function"
      ? db.getLatestAttributedProjectDir(sessionId)
      : null;
    const userAttributions = resolveProjectAttributions(userEvents, {
      sessionOriginDir: sessionStats?.project_dir || projectDir,
      inputProjectDir: projectDir,
      workspaceRoots: Array.isArray(input.workspace_roots) ? input.workspace_roots : [],
      lastKnownProjectDir: savedLastKnown || lastKnownProjectDir,
    });
    for (let i = 0; i < userEvents.length; i++) {
      db.insertEvent(sessionId, userEvents[i], "UserPromptSubmit", userAttributions[i]);
    }

    db.close();
  }
} catch {
  // Kimi Code hooks must not block the session.
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "" },
}) + "\n");
