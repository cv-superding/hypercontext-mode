/**
 * extractTranscriptUsageSince — cursor-aware main-turn capture.
 *
 * The Stop hook reads the FULL transcript every turn, but the transcript grows
 * monotonically. To FORWARD only NEW spend (no double-count), we walk turns
 * AFTER a per-session high-water `sinceUuid` cursor and advance the cursor to
 * the last assistant turn's uuid. Compaction (cursor no longer present) falls
 * back to the LAST turn only — never re-emitting the whole history.
 *
 * Same char-algorithmic JSONL parse as extractTranscriptUsage (NO regex),
 * same buildAgentUsageEvent path, same sidechain exclusion.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractTranscriptUsageSince } from "../../src/session/extract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "claude-code-transcript.jsonl");

function transcriptText(): string {
  return readFileSync(FIXTURE, "utf-8");
}

function byModel(events: ReturnType<typeof extractTranscriptUsageSince>["events"]) {
  const map = new Map<string, (typeof events)[number]>();
  for (const e of events) if (e.model_id) map.set(e.model_id, e);
  return map;
}

describe("extractTranscriptUsageSince — cursor-aware capture", () => {
  // (a) null cursor → process ALL turns (parity with extractTranscriptUsage)
  test("(a) null cursor sums all non-sidechain turns", () => {
    const { events } = extractTranscriptUsageSince(transcriptText(), null);
    const m = byModel(events);
    // sonnet: a1(1000/500) + a2(2000/800,cc1000,cr1500) + a4(0). Sidechain excluded.
    const sonnet = m.get("claude-sonnet-4-6");
    expect(sonnet).toBeDefined();
    expect(sonnet!.input_tokens).toBe(3000);
    expect(sonnet!.output_tokens).toBe(1300);
    expect(sonnet!.cache_creation_tokens).toBe(1000);
    expect(sonnet!.cache_read_tokens).toBe(1500);
    // opus: a3(1000/500)
    const opus = m.get("claude-opus-4-8");
    expect(opus).toBeDefined();
    expect(opus!.input_tokens).toBe(1000);
    expect(events.length).toBe(2);
  });

  // (b) cursor=a1 → only a2..a4 summed (a1 EXCLUDED)
  test("(b) cursor=a1 processes turns strictly after a1", () => {
    const { events } = extractTranscriptUsageSince(transcriptText(), "a1");
    const m = byModel(events);
    // sonnet now: a2(2000/800) + a4(0) — a1's 1000/500 must NOT be counted.
    const sonnet = m.get("claude-sonnet-4-6");
    expect(sonnet).toBeDefined();
    expect(sonnet!.input_tokens).toBe(2000);
    expect(sonnet!.output_tokens).toBe(800);
    expect(sonnet!.cache_creation_tokens).toBe(1000);
    expect(sonnet!.cache_read_tokens).toBe(1500);
    // opus a3 still after a1
    const opus = m.get("claude-opus-4-8");
    expect(opus).toBeDefined();
    expect(opus!.input_tokens).toBe(1000);
  });

  // (c) cursor set but NOT found (compaction) → ONLY the LAST turn
  test("(c) missing cursor falls back to the last assistant turn only", () => {
    // Use a transcript whose last non-zero turn is opus so we can assert a
    // single, bounded emission instead of the whole history.
    const lines = [
      JSON.stringify({ type: "assistant", uuid: "x1", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 5000, output_tokens: 100 } } }),
      JSON.stringify({ type: "assistant", uuid: "x2", message: { model: "claude-opus-4-8", usage: { input_tokens: 700, output_tokens: 300 } } }),
    ].join("\n");
    const { events } = extractTranscriptUsageSince(lines, "vanished-cursor");
    // Only x2 (the LAST turn) is emitted — x1's 5000 input must be absent.
    expect(events.length).toBe(1);
    expect(events[0].model_id).toBe("claude-opus-4-8");
    expect(events[0].input_tokens).toBe(700);
    expect(events[0].output_tokens).toBe(300);
  });

  // (d) cursor advances to the LAST assistant uuid in the transcript
  test("(d) returned cursor is the last assistant turn uuid", () => {
    const { cursor } = extractTranscriptUsageSince(transcriptText(), null);
    // fixture order: a1, a2, a3, sc1(sidechain), a4 → last assistant line is a4.
    // sidechain lines still set the cursor? No — cursor tracks the same turns we
    // walk. a4 is the last NON-sidechain assistant turn and the last line.
    expect(cursor).toBe("a4");
  });

  // (e) no NEW turns since cursor → empty events, cursor unchanged at last uuid
  test("(e) cursor at last turn yields no events but keeps the cursor", () => {
    const { events, cursor } = extractTranscriptUsageSince(transcriptText(), "a4");
    expect(events).toEqual([]);
    expect(cursor).toBe("a4");
  });

  // (f) sidechain turns remain excluded regardless of cursor
  test("(f) sidechain turns are excluded under cursor walk", () => {
    // cursor a2 → remaining turns: a3(opus), sc1(sidechain), a4(sonnet zero).
    const { events } = extractTranscriptUsageSince(transcriptText(), "a2");
    const m = byModel(events);
    // sidechain sonnet (9999) must NOT appear; a4 is zero → sonnet emits nothing.
    expect(m.get("claude-sonnet-4-6")).toBeUndefined();
    // only opus a3 survives.
    const opus = m.get("claude-opus-4-8");
    expect(opus).toBeDefined();
    expect(opus!.input_tokens).toBe(1000);
    expect(events.length).toBe(1);
  });

  // (g) empty / whitespace transcript → no events, cursor stays as input
  test("(g) empty transcript returns input cursor unchanged", () => {
    expect(extractTranscriptUsageSince("", null)).toEqual({ events: [], cursor: null });
    expect(extractTranscriptUsageSince("   \n\n", "keep")).toEqual({ events: [], cursor: "keep" });
    // @ts-expect-error — exercise the null guard
    expect(extractTranscriptUsageSince(null, "keep")).toEqual({ events: [], cursor: "keep" });
  });
});
