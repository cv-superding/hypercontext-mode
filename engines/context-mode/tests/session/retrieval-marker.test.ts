/**
 * retrieval-marker — server→hook bridge for the "With context-mode"
 * (bytes_retrieved) signal.
 *
 * context-mode's OWN MCP retrieval tools (ctx_search / ctx_fetch_and_index)
 * never fire a PostToolUse hook for the plugin's own server, so the hook-side
 * extractMcpToolCall path can never observe them — verified empirically:
 * 0 mcp_tool_call events + bytes_retrieved 0/124454 in production D1.
 *
 * The MCP server DOES measure each retrieval's response byte length. It drops
 * that count into a tmp marker keyed by the session DB basename; the next
 * PostToolUse fire (which runs for ordinary tools) consumes the marker and
 * emits a forwardable event carrying bytes_retrieved. This file pins the
 * marker round-trip.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  appendRetrievalBytes,
  consumeRetrievalBytes,
  retrievalMarkerPath,
} from "../../src/session/retrieval-marker.js";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp(): string { const d = mkdtempSync(join(tmpdir(), "ret-marker-")); dirs.push(d); return d; }

describe("retrieval-marker (server→hook bytes_retrieved bridge)", () => {
  test("append then consume returns the byte count; marker is gone after (no double-count)", () => {
    const tmp = mkTmp();
    const db = "/proj/ab1f2761cd647e9c__ab1f2761.db";
    appendRetrievalBytes(db, 100279, tmp);
    expect(consumeRetrievalBytes(db, tmp)).toBe(100279);
    // consumed → deleted → a later hook fire cannot re-forward the same bytes
    expect(consumeRetrievalBytes(db, tmp)).toBe(0);
  });

  test("multiple retrievals before one hook flush accumulate; zero/negative ignored", () => {
    const tmp = mkTmp();
    const db = "/proj/sess.db";
    appendRetrievalBytes(db, 3009, tmp);
    appendRetrievalBytes(db, 100279, tmp);
    appendRetrievalBytes(db, 0, tmp);    // no retrieval payload — ignored
    appendRetrievalBytes(db, -5, tmp);   // guard
    expect(consumeRetrievalBytes(db, tmp)).toBe(103288);
  });

  test("marker keyed by DB basename so server + hook resolve the SAME file from the shared DB path", () => {
    const tmp = mkTmp();
    const p = retrievalMarkerPath("/a/b/ab1f2761__x.db", tmp);
    expect(p).toContain("ab1f2761__x.db");
    // server and hook both derive the path from getSessionDb(Path) → same basename
    expect(retrievalMarkerPath("/a/b/ab1f2761__x.db", tmp))
      .toBe(retrievalMarkerPath("/a/b/ab1f2761__x.db", tmp));
  });

  test("missing marker consumes to 0 (phantom-event guard)", () => {
    expect(consumeRetrievalBytes("/proj/never-written.db", mkTmp())).toBe(0);
  });
});
