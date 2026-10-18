/**
 * Server→hook bridge for the retrieval ("With context-mode") byte count.
 *
 * WHY THIS EXISTS — context-mode's OWN MCP retrieval tools (ctx_search /
 * ctx_fetch_and_index) never fire a PostToolUse hook for the plugin's own
 * server, so the hook-side `extractMcpToolCall` path can never observe them
 * (verified empirically: 0 `mcp_tool_call` events locally, bytes_retrieved
 * 0/124454 in production D1). The MCP server, however, measures each
 * retrieval response's byte length directly.
 *
 * The server appends that count to a tmp marker keyed by the session DB
 * *basename* — the one identifier the server process and the hook process
 * both resolve reliably (CLAUDE_SESSION_ID is not guaranteed in the server
 * env; the per-project session DB path is). The next PostToolUse fire — which
 * DOES run for ordinary tools (Bash/Read/Edit) — consumes the marker and
 * emits a forwardable event carrying `bytes_retrieved`. Mirrors the existing
 * redirect / latency / rejected marker handshake in posttooluse.mjs.
 */

import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * Tmp marker path for a session DB. Keyed by basename so the server (which
 * holds the DB path via getSessionDbPath) and the hook (getSessionDBPath)
 * derive the SAME file. Session DB filenames embed the worktree hash
 * (`<hash>__<suffix>.db`), so basename collisions across projects are
 * negligible.
 */
export function retrievalMarkerPath(sessionDbPath: string, tmpDir: string = tmpdir()): string {
  return join(tmpDir, `context-mode-retrieval-${basename(sessionDbPath)}.txt`);
}

/**
 * Record one retrieval's response byte count. Positive-only (a 0-byte or
 * failed retrieval is not a context cost). Append-only so several retrievals
 * between two hook fires accumulate. Best-effort — never throws into the
 * MCP response path.
 */
export function appendRetrievalBytes(sessionDbPath: string, bytes: number, tmpDir?: string): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  try {
    appendFileSync(retrievalMarkerPath(sessionDbPath, tmpDir), `${Math.floor(bytes)}\n`);
  } catch { /* best-effort — never block the MCP response */ }
}

/**
 * Sum every recorded retrieval and delete the marker (consume-once) so the
 * next PostToolUse fire cannot re-forward the same bytes. Returns 0 when no
 * marker exists (phantom-event guard).
 */
export function consumeRetrievalBytes(sessionDbPath: string, tmpDir?: string): number {
  const path = retrievalMarkerPath(sessionDbPath, tmpDir);
  let total = 0;
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const n = Number.parseInt(line, 10);
      if (Number.isFinite(n) && n > 0) total += n;
    }
    rmSync(path, { force: true });
  } catch { /* no marker — phantom-event guard */ }
  return total;
}
