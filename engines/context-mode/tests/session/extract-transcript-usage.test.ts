/**
 * claude-code MAIN-turn usage capture — the dominant-spend gap.
 *
 * The capability matrix (refs/platforms/claude-code) proved the main
 * conversation turns live in the session transcript JSONL: each
 * `type:"assistant"` line carries `message.usage{input_tokens,
 * output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`
 * plus `message.model`. usage is a PER-TURN delta, so summing assistant
 * turns = exact billed total for the main agent.
 *
 * Field mapping (transcript → SessionEvent):
 *   cache_creation_input_tokens → cache_creation_tokens
 *   cache_read_input_tokens     → cache_read_tokens
 *
 * DOUBLE-COUNT GUARD (refs):
 *   src/utils/sessionStorage.ts:247-257 — subagents write to a SEPARATE
 *   `subagents/agent-{id}.jsonl`; insertMessageChain stamps
 *   `isSidechain:true` (sessionStorage.ts:1042) on those entries, and the
 *   parent loop filters them out (stats.ts:231-235). Task-subagent usage is
 *   therefore NOT in the parent transcript's countable assistant turns —
 *   summing the parent does NOT double-count the Task tool_response path.
 *   We additionally skip any `isSidechain === true` line as belt-and-braces.
 *
 * extractTranscriptUsage parses the JSONL char-algorithmically (line split,
 * JSON.parse per line, no regex), sums message.usage per message.model, and
 * emits one `agent_usage` event per distinct model via buildAgentUsageEvent.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractTranscriptUsage } from "../../src/session/extract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "claude-code-transcript.jsonl");

function transcriptText(): string {
  return readFileSync(FIXTURE, "utf-8");
}

function byModel(events: ReturnType<typeof extractTranscriptUsage>) {
  const map = new Map<string, (typeof events)[number]>();
  for (const e of events) if (e.model_id) map.set(e.model_id, e);
  return map;
}

describe("extractTranscriptUsage — claude-code main-turn capture", () => {
  // (a) main-turn usage parsed + summed per model from a fixture transcript
  test("(a) sums message.usage per model across assistant turns", () => {
    const events = extractTranscriptUsage(transcriptText());
    const sonnet = byModel(events).get("claude-sonnet-4-6");
    expect(sonnet).toBeDefined();
    // a1 (1000/500) + a2 (2000/800, cc 1000, cr 1500) + a4 (all-zero, no add).
    // Sidechain line (9999s) MUST be excluded.
    expect(sonnet!.input_tokens).toBe(3000);
    expect(sonnet!.output_tokens).toBe(1300);
    expect(sonnet!.cache_creation_tokens).toBe(1000);
    expect(sonnet!.cache_read_tokens).toBe(1500);
    expect(sonnet!.type).toBe("agent_usage");
    expect(sonnet!.category).toBe("cost");
  });

  // (b) cost_usd computed from catalog
  test("(b) cost_usd derived from pricing catalog", () => {
    const events = extractTranscriptUsage(transcriptText());
    const sonnet = byModel(events).get("claude-sonnet-4-6");
    // 3000*3 + 1300*15 + 1000*3.75 + 1500*0.30 = 9000+19500+3750+450 = 32700
    // 32700 / 1_000_000 = 0.0327
    expect(sonnet!.cost_usd).toBeCloseTo(0.0327, 8);
    expect(sonnet!.data).toMatch(/cost_usd:0\.0327/);
  });

  // (c) two models in one session → two events
  test("(c) two distinct models → two events", () => {
    const events = extractTranscriptUsage(transcriptText());
    expect(events.length).toBe(2);
    const m = byModel(events);
    const opus = m.get("claude-opus-4-8");
    expect(opus).toBeDefined();
    expect(opus!.input_tokens).toBe(1000);
    expect(opus!.output_tokens).toBe(500);
    // opus-4-8: 1000 in + 500 out = 0.0175 (matches pricing regression test)
    expect(opus!.cost_usd).toBeCloseTo(0.0175, 8);
  });

  // (c2) double-count guard — sidechain usage excluded
  test("(c2) isSidechain assistant turns are excluded (no double-count)", () => {
    const events = extractTranscriptUsage(transcriptText());
    const sonnet = byModel(events).get("claude-sonnet-4-6");
    // If the 9999-token sidechain leaked in, input would be 12999 not 3000.
    expect(sonnet!.input_tokens).toBe(3000);
  });

  // (d) malformed / legacy lines skipped (no throw)
  test("(d) malformed and non-assistant lines are skipped without throwing", () => {
    const dirty = [
      "not json at all",
      "{ broken json",
      JSON.stringify({ type: "summary", summary: "x" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      "",
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    ].join("\n");
    let events: ReturnType<typeof extractTranscriptUsage> = [];
    expect(() => { events = extractTranscriptUsage(dirty); }).not.toThrow();
    expect(events.length).toBe(1);
    expect(events[0].input_tokens).toBe(10);
  });

  test("(d2) empty / whitespace transcript → no events, no throw", () => {
    expect(extractTranscriptUsage("")).toEqual([]);
    expect(extractTranscriptUsage("   \n\n  \n")).toEqual([]);
    // @ts-expect-error — exercise the null guard
    expect(extractTranscriptUsage(null)).toEqual([]);
  });

  // (e) zero-usage → no event
  test("(e) a model whose every turn is zero-token emits no event", () => {
    const zeros = [
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-haiku-4-5", usage: { input_tokens: 0, output_tokens: 0 } },
      }),
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-haiku-4-5", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      }),
    ].join("\n");
    expect(extractTranscriptUsage(zeros)).toEqual([]);
  });

  test("(e2) unknown model still emits usage event but no cost_usd", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { model: "mystery-vendor/unknown-9000", usage: { input_tokens: 100, output_tokens: 50 } },
    });
    const events = extractTranscriptUsage(line);
    expect(events.length).toBe(1);
    expect(events[0].input_tokens).toBe(100);
    expect(events[0].cost_usd).toBeUndefined();
    expect(events[0].data).not.toMatch(/cost_usd:/);
  });
});
