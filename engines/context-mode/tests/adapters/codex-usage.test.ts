/**
 * parseCodexUsage / extractCodexUsageSince — Codex CLI per-turn token capture.
 *
 * Ground truth: context-mode-platform/docs/prds/2026-06-paid-observability/
 * adapter-matrix/codex.md (refs codex-rs protocol.rs). Codex carries per-turn
 * usage on `EventMsg::TokenCount(TokenCountEvent)` (protocol.rs:1276), which is
 * ALSO persisted to the session rollout JSONL as a `type:"event_msg"` record
 * with `payload.type === "token_count"`. The payload mirrors TokenCountEvent:
 *   info: Option<TokenUsageInfo> = { total_token_usage, last_token_usage,
 *                                    model_context_window }
 * with TokenUsage = { input_tokens, cached_input_tokens, output_tokens,
 *                     reasoning_output_tokens, total_tokens } (protocol.rs:2000).
 *
 * These tests pin (1) the incremental `last_token_usage` mapping (NOT the
 * cumulative `total_token_usage`), (2) reasoning folded into output, (3)
 * cached_input_tokens → cache_read, (4) info:null skip (session ping / aborted
 * turn), and (5) the cursor-gated, per-model, no-double-count rollout walk.
 * The rollout-line fixtures are byte-shaped from real ~/.codex rollout files.
 * NO regex; pure algorithmic parse.
 */

import { describe, it, expect } from "vitest";
import {
  parseCodexUsage,
  extractCodexUsageSince,
} from "../../src/adapters/codex/usage.js";

/** A completed-turn token_count payload (info populated). */
function tokenCount(last: Record<string, number>, total?: Record<string, number>) {
  return {
    type: "token_count",
    info: {
      total_token_usage: total ?? {
        input_tokens: 99999,
        cached_input_tokens: 99999,
        output_tokens: 99999,
        reasoning_output_tokens: 99999,
        total_tokens: 99999,
      },
      last_token_usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
        ...last,
      },
      model_context_window: 258400,
    },
    rate_limits: { limit_id: "codex", primary: null, secondary: null },
  };
}

/** Wrap a payload as a rollout JSONL line. */
function line(type: string, payload: unknown): string {
  return JSON.stringify({ timestamp: "2026-05-11T14:12:23.754Z", type, payload });
}

describe("parseCodexUsage", () => {
  it("maps last_token_usage to the buildAgentUsageEvent shape (incremental, not cumulative)", () => {
    const counts = parseCodexUsage(
      tokenCount({
        input_tokens: 1200,
        cached_input_tokens: 4096,
        output_tokens: 340,
        reasoning_output_tokens: 60,
      }),
      "gpt-5.5",
    );
    expect(counts).toEqual({
      model_id: "gpt-5.5",
      input_tokens: 1200,
      output_tokens: 400, // 340 output + 60 reasoning (reasoning billed as output)
      cache_creation_tokens: 0,
      cache_read_tokens: 4096, // cached_input_tokens -> cache_read
      native_cost_usd: null,
    });
  });

  it("reads last_token_usage, never total_token_usage (no cumulative double-count)", () => {
    const counts = parseCodexUsage(
      tokenCount(
        { input_tokens: 10, output_tokens: 5 },
        { input_tokens: 9_000_000, output_tokens: 9_000_000 },
      ),
      "gpt-5.5",
    );
    expect(counts?.input_tokens).toBe(10);
    expect(counts?.output_tokens).toBe(5);
  });

  it("returns null for the session-start ping / interrupted turn (info: null)", () => {
    const payload = { type: "token_count", info: null, rate_limits: {} };
    expect(parseCodexUsage(payload, "gpt-5.5")).toBeNull();
  });

  it("returns null for an all-zero last_token_usage", () => {
    expect(parseCodexUsage(tokenCount({}), "gpt-5.5")).toBeNull();
  });

  it("rejects non-token_count payloads and non-objects", () => {
    expect(parseCodexUsage({ type: "agent_message" }, "gpt-5.5")).toBeNull();
    expect(parseCodexUsage(null, "gpt-5.5")).toBeNull();
    expect(parseCodexUsage("nope", "gpt-5.5")).toBeNull();
  });
});

describe("extractCodexUsageSince", () => {
  it("sums new completed turns since cursor and resolves model from turn_context", () => {
    const rollout = [
      line("session_meta", { id: "abc", model: "gpt-5.0" }),
      line("turn_context", { model: "gpt-5.5" }),
      line("event_msg", { type: "user_message", message: "hi" }),
      line("event_msg", tokenCount({ input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 10 })),
      line("event_msg", tokenCount({ input_tokens: 200, cached_input_tokens: 50, output_tokens: 30 })),
    ].join("\n");

    const { events, cursor } = extractCodexUsageSince(rollout, null);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.type).toBe("agent_usage");
    // input 100+200=300, output (20+10)+30=60, cache_read 0+50=50
    expect(ev.data).toContain("tokens_in:300");
    expect(ev.data).toContain("tokens_out:60");
    expect(ev.data).toContain("cache_read:50");
    // cursor = index of the last parseable line (5 lines, idx 0..4) = "4"
    expect(cursor).toBe("4");
  });

  it("is cursor-gated: a second pass past the cursor only counts new turns (no double-count)", () => {
    const first = [
      line("turn_context", { model: "gpt-5.5" }),
      line("event_msg", tokenCount({ input_tokens: 100, output_tokens: 20 })),
    ].join("\n");
    const pass1 = extractCodexUsageSince(first, null);
    expect(pass1.events).toHaveLength(1);
    expect(pass1.cursor).toBe("1");

    // Rollout grows by one new completed turn; re-read gated on prior cursor.
    const second = [
      first,
      line("event_msg", tokenCount({ input_tokens: 500, output_tokens: 70 })),
    ].join("\n");
    const pass2 = extractCodexUsageSince(second, pass1.cursor);
    expect(pass2.events).toHaveLength(1);
    expect(pass2.events[0].data).toContain("tokens_in:500"); // ONLY the new turn
    expect(pass2.events[0].data).toContain("tokens_out:70");
    expect(pass2.cursor).toBe("2");
  });

  it("groups per-model when the model switches mid-session", () => {
    const rollout = [
      line("turn_context", { model: "gpt-5.5" }),
      line("event_msg", tokenCount({ input_tokens: 100, output_tokens: 10 })),
      line("turn_context", { model: "gpt-5.5-codex" }),
      line("event_msg", tokenCount({ input_tokens: 200, output_tokens: 20 })),
    ].join("\n");
    const { events } = extractCodexUsageSince(rollout, null);
    // one agent_usage event per model in the new slice (no cross-model merge)
    expect(events).toHaveLength(2);
    const joined = events.map((e) => e.data).join("|");
    expect(joined).toContain("tokens_in:100");
    expect(joined).toContain("tokens_in:200");
  });

  it("skips info:null pings and advances the cursor to the last line regardless", () => {
    const rollout = [
      line("session_meta", { id: "abc", model: "gpt-5.5" }),
      line("event_msg", { type: "token_count", info: null, rate_limits: {} }),
      line("event_msg", { type: "agent_message", message: "thinking" }),
    ].join("\n");
    const { events, cursor } = extractCodexUsageSince(rollout, null);
    expect(events).toHaveLength(0);
    expect(cursor).toBe("2"); // advanced past settled lines even with no usage
  });

  it("tolerates a trailing newline and a partially-flushed final line", () => {
    const rollout =
      [
        line("turn_context", { model: "gpt-5.5" }),
        line("event_msg", tokenCount({ input_tokens: 100, output_tokens: 10 })),
      ].join("\n") + '\n{"type":"event_msg","payload":{"type":"token_';
    const { events, cursor } = extractCodexUsageSince(rollout, null);
    expect(events).toHaveLength(1);
    expect(cursor).toBe("1"); // partial line not counted as the new cursor
  });

  it("returns the input cursor unchanged for an empty rollout", () => {
    expect(extractCodexUsageSince("", "7")).toEqual({ events: [], cursor: "7" });
  });
});
