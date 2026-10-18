#!/usr/bin/env node
/**
 * PostToolUse hook for context-mode session continuity.
 *
 * Captures session events from tool calls (13 categories) and stores
 * them in the per-project SessionDB for later resume snapshot building.
 *
 * Must be fast (<20ms). No network, no LLM, just SQLite writes.
 *
 * Crash-resilience: wrapped via runHook (#414).
 */

import { runHook } from "./run-hook.mjs";

await runHook(async () => {
  const {
    readStdin,
    parseStdin,
    getSessionId,
    getSessionDBPath,
    getInputProjectDir,
  } = await import("./session-helpers.mjs");
  const { createSessionLoaders, attributeAndInsertEvents } = await import("./session-loaders.mjs");
  const { dirname, resolve, basename } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { readFileSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  // Resolve absolute path for imports — relative dynamic imports can fail
  // when Claude Code invokes hooks from a different working directory.
  const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
  const { loadSessionDB, loadExtract, loadProjectAttribution } = createSessionLoaders(HOOK_DIR);

  try {
    const raw = await readStdin();
    const input = parseStdin(raw);
    const projectDir = getInputProjectDir(input);

    const { extractEvents } = await loadExtract();
    const { resolveProjectAttributions } = await loadProjectAttribution();
    const { SessionDB } = await loadSessionDB();

    const dbPath = getSessionDBPath();
    const db = new SessionDB({ dbPath });
    const sessionId = getSessionId(input);

    // Ensure session meta exists
    db.ensureSession(sessionId, projectDir);

    // Extract and store events
    const events = extractEvents({
      tool_name: input.tool_name,
      tool_input: input.tool_input ?? {},
      tool_response: typeof input.tool_response === "string"
        ? input.tool_response
        : JSON.stringify(input.tool_response ?? ""),
      tool_output: input.tool_output,
    });

    attributeAndInsertEvents(db, sessionId, events, input, projectDir, "PostToolUse", resolveProjectAttributions);

    // ─── Category 18: Rejected-approach — read PreToolUse marker ───
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
        // v1.0.160: route through attributeAndInsertEvents so the bridge wire
        // receives this event too. db.insertEvent only writes locally — the
        // dashboard's rejection-rate widget needs the platform row.
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

    // ─── D2 PRD Phase 3/4: redirect marker — emit byte-accounting event ───
    // PreToolUse wrote `context-mode-redirect-${sessionId}.txt` for tools whose
    // output we kept out of the model's context window (curl/wget, WebFetch,
    // large Read). Format: `tool:type:bytesAvoided:commandSummary` (Override C).
    try {
      const redirectPath = resolve(tmpdir(), `context-mode-redirect-${sessionId}.txt`);
      let redirectData;
      try {
        redirectData = readFileSync(redirectPath, "utf-8").trim();
        // Slice 3.3: unlink so the next PostToolUse for an unrelated tool call
        // does NOT re-emit the same event (no double-accounting).
        unlinkSync(redirectPath);
      } catch { /* no marker — Slice 3.4: phantom-event guard */ }

      if (redirectData) {
        // Parse first 3 colons; the rest (commandSummary) may itself contain
        // colons (URLs do — `https://`). Avoid `split(":", 4)` which would
        // truncate the summary at any embedded colon.
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
            // v1.0.160: route through wire — context-saving (byte-accounting)
            // widget on the platform reads category='redirect' rows. event
            // carries bytes_avoided so the bytesList branch in
            // attributeAndInsertEvents stamps the column.
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
    } catch { /* best-effort — never block hook */ }

    // ─── Category 27: Latency — read cross-hook marker and emit event if slow ───
    try {
      const toolName = input.tool_name ?? "";
      if (toolName) {
        const markerPath = resolve(tmpdir(), `context-mode-latency-${sessionId}-${toolName}.txt`);
        let startTime;
        try {
          startTime = parseInt(readFileSync(markerPath, "utf-8").trim(), 10);
          unlinkSync(markerPath);
        } catch {
          // No marker — pretooluse didn't write one or already consumed
        }
        if (startTime && !isNaN(startTime)) {
          const duration = Date.now() - startTime;
          if (duration > 5000) {
            // v1.0.160: route through wire — slow-tool insights need this row.
            attributeAndInsertEvents(
              db,
              sessionId,
              [{
                type: "tool_latency",
                category: "latency",
                data: `${toolName}: ${duration}ms`,
                priority: 3,
              }],
              input,
              projectDir,
              "PostToolUse",
              resolveProjectAttributions,
            );
          }
        }
      }
    } catch { /* latency tracking is best-effort */ }

    // ─── Retrieval bridge: emit the "With context-mode" (bytes_retrieved) row ───
    // The MCP server appended ctx_search / ctx_fetch_and_index response bytes to
    // a marker keyed by the session DB basename (the hook NEVER fires for the
    // plugin's own MCP tools, so this is the only place that signal can enter
    // the forward stream). Consume + emit one forwardable event so the platform
    // kept_out_pct goes "measured". Mirrors the redirect-marker handshake above.
    try {
      const marker = resolve(tmpdir(), `context-mode-retrieval-${basename(dbPath)}.txt`);
      let retrievedBytes = 0;
      try {
        const raw = readFileSync(marker, "utf-8");
        for (const line of raw.split("\n")) {
          const n = parseInt(line, 10);
          if (Number.isFinite(n) && n > 0) retrievedBytes += n;
        }
        unlinkSync(marker); // consume-once — next fire cannot re-forward
      } catch { /* no marker — phantom-event guard */ }
      if (retrievedBytes > 0) {
        // session-loaders stamps bytes_retrieved onto the platform payload from
        // this in-memory field (session_events has no such column — forward-only).
        attributeAndInsertEvents(
          db,
          sessionId,
          [{
            type: "mcp_tool_call",
            category: "retrieval",
            data: `retrieval: ${retrievedBytes} bytes accessed`,
            priority: 2,
            bytes_retrieved: retrievedBytes,
          }],
          input,
          projectDir,
          "PostToolUse",
          resolveProjectAttributions,
        );
      }
    } catch { /* best-effort — never block the hook */ }

    db.close();
  } catch {
    // PostToolUse must never block the session — silent fallback
  }

  // PostToolUse hooks don't need hookSpecificOutput
});
