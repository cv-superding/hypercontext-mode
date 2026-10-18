#!/usr/bin/env node
import "../suppress-stderr.mjs";
import "../ensure-deps.mjs";
/**
 * Gemini CLI AfterModel hook — per-turn token / cost capture.
 *
 * AfterModel fires per model call inside gemini-cli's stream loop
 * (packages/core/src/core/geminiChat.ts:1213). The hook payload carries
 * `llm_request` + `llm_response` (hooks/types.ts:692-695); the real Gemini
 * `usageMetadata` (promptTokenCount, candidatesTokenCount, +cachedContent/
 * thoughts when present) and resolved model live on `llm_response`
 * (hookTranslator.ts:60-64, loggingContentGenerator.ts:405,553).
 *
 * parseGeminiUsage maps that into a builder `agent_usage` event; cost_usd is
 * derived from the pricing catalog (gemini exposes no native cost). The event
 * is forwarded via attributeAndInsertEvents — same path as hooks/stop.mjs.
 *
 * One AfterModel call = one billed model round-trip = one priced event.
 * Per-userPromptId summation into a single per-turn total is deferred; emitting
 * per-call never double-counts (each call's usageMetadata is authoritative).
 *
 * Must be fast (<20ms). No network, no LLM, just a parse + SQLite write.
 * AfterModel is non-blocking — no stdout output.
 */

import { readStdin, parseStdin, getSessionId, getSessionDBPath, getInputProjectDir, GEMINI_OPTS } from "../session-helpers.mjs";
import { createSessionLoaders, attributeAndInsertEvents } from "../session-loaders.mjs";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);
const OPTS = GEMINI_OPTS;
const DEBUG_LOG = join(homedir(), ".gemini", "context-mode", "aftermodel-debug.log");

try {
  const raw = await readStdin();
  const input = parseStdin(raw);
  const projectDir = getInputProjectDir(input, OPTS);

  const { parseGeminiUsage } = await loadExtract();
  const event = parseGeminiUsage(input);

  if (event) {
    const { resolveProjectAttributions } = await loadProjectAttribution();
    const { SessionDB } = await loadSessionDB();

    const dbPath = getSessionDBPath(OPTS, projectDir);
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input, OPTS);
    db.ensureSession(sessionId, projectDir);

    // attributeAndInsertEvents both INSERTS locally and FORWARDS to the
    // platform (gated on ~/.context-mode/platform.json) — same as stop.mjs.
    attributeAndInsertEvents(db, sessionId, [event], input, projectDir, "AfterModel", resolveProjectAttributions);
    db.close();

    try {
      appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] OK: ${event.model_id ?? "?"} in:${event.input_tokens ?? 0} out:${event.output_tokens ?? 0}\n`);
    } catch { /* silent */ }
  }
} catch (err) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ERR: ${err?.message || err}\n`);
  } catch { /* silent */ }
}

// AfterModel is non-blocking — no stdout output
