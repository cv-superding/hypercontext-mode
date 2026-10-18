/**
 * parseKimiUsage + extractKimiUsageSince — Kimi Code (kimi-code) per-turn
 * token capture via the wire.jsonl `usage.record` stream.
 *
 * Ground truth: context-mode-platform/docs/prds/2026-06-paid-observability/
 * adapter-matrix/kimi.md (+ cited refs). Kimi Code surfaces real per-turn token
 * usage + model ONLY on <sessionDir>/wire.jsonl `usage.record` lines (NOT in
 * any hook stdin); usage is the normalized four-field TokenUsage
 * { inputOther, output, inputCacheRead, inputCacheCreation } and is INCREMENTAL
 * (per-step deltas, summed). Hooks carry NO usage.
 *
 * These tests pin (1) the field mapping + zero->null contract of the single
 * record parse, and (2) the cursor-gated incremental since-reader (no
 * double-count, per-model summation, bounded compaction fallback). NO regex.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseKimiUsage, extractKimiUsageSince } from "../../src/adapters/kimi/usage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "kimi-wire.jsonl");

function wireText(): string {
  return readFileSync(FIXTURE, "utf-8");
}

function byModel(events: ReturnType<typeof extractKimiUsageSince>["events"]) {
  const map = new Map<string, (typeof events)[number]>();
  for (const e of events) if (e.model_id) map.set(e.model_id, e);
  return map;
}

describe("parseKimiUsage — single usage.record mapping", () => {
  test("maps the four TokenUsage fields + model", () => {
    const counts = parseKimiUsage({
      type: "usage.record",
      model: "kimi-k2",
      usage: { inputOther: 2000, output: 800, inputCacheRead: 1500, inputCacheCreation: 1000 },
    });
    expect(counts).not.toBeNull();
    expect(counts!.model_id).toBe("kimi-k2");
    expect(counts!.input_tokens).toBe(2000);
    expect(counts!.output_tokens).toBe(800);
    expect(counts!.cache_read_tokens).toBe(1500);
    expect(counts!.cache_creation_tokens).toBe(1000);
    // kimi-code TokenUsage has no native USD field — defer to the catalog.
    expect(counts!.native_cost_usd ?? null).toBeNull();
  });

  test("tolerates a bare {model,usage} record (no type discriminator)", () => {
    const counts = parseKimiUsage({
      model: "kimi-k2",
      usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    expect(counts).not.toBeNull();
    expect(counts!.input_tokens).toBe(10);
    expect(counts!.output_tokens).toBe(5);
  });

  test("rejects a non-usage record type", () => {
    expect(parseKimiUsage({ type: "tool.call", model: "kimi-k2", usage: { inputOther: 1 } })).toBeNull();
  });

  test("all-zero usage → null (no no-op cost event)", () => {
    const counts = parseKimiUsage({
      type: "usage.record",
      model: "kimi-k2",
      usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    expect(counts).toBeNull();
  });

  test("null / non-object / missing usage → null", () => {
    expect(parseKimiUsage(null)).toBeNull();
    expect(parseKimiUsage(undefined)).toBeNull();
    expect(parseKimiUsage("usage.record")).toBeNull();
    expect(parseKimiUsage({ type: "usage.record", model: "kimi-k2" })).toBeNull();
  });

  test("negative / NaN token values are clamped to 0", () => {
    const counts = parseKimiUsage({
      type: "usage.record",
      model: "kimi-k2",
      usage: { inputOther: -5, output: Number.NaN, inputCacheRead: 1500, inputCacheCreation: 0 },
    });
    expect(counts).not.toBeNull();
    expect(counts!.input_tokens).toBe(0);
    expect(counts!.output_tokens).toBe(0);
    expect(counts!.cache_read_tokens).toBe(1500);
  });
});

describe("extractKimiUsageSince — cursor-gated incremental capture", () => {
  // Fixture has 4 usage.record lines (1 of them all-zero):
  //   #0 kimi-k2          1000/500
  //   #1 kimi-k2          2000/800, cr1500, cc1000
  //   #2 kimi-k2-thinking  300/120
  //   #3 kimi-k2             0/0    (zero — counted toward cursor, no tokens)

  test("(a) null cursor sums ALL usage.record lines per model; cursor → '4'", () => {
    const { events, cursor } = extractKimiUsageSince(wireText(), null);
    const m = byModel(events);
    const k2 = m.get("kimi-k2");
    expect(k2).toBeDefined();
    expect(k2!.input_tokens).toBe(3000); // 1000 + 2000 (+ 0)
    expect(k2!.output_tokens).toBe(1300); // 500 + 800
    expect(k2!.cache_read_tokens).toBe(1500);
    expect(k2!.cache_creation_tokens).toBe(1000);
    const thinking = m.get("kimi-k2-thinking");
    expect(thinking).toBeDefined();
    expect(thinking!.input_tokens).toBe(300);
    expect(thinking!.output_tokens).toBe(120);
    expect(events.length).toBe(2);
    // cursor counts the TOTAL usage.record lines seen (incl. the zero one).
    expect(cursor).toBe("4");
  });

  test("(b) cursor='2' processes ONLY records after index 2 (no double-count)", () => {
    const { events, cursor } = extractKimiUsageSince(wireText(), "2");
    const m = byModel(events);
    // records #2 (thinking 300/120) and #3 (zero) remain. k2 zero → no event.
    expect(m.get("kimi-k2")).toBeUndefined();
    const thinking = m.get("kimi-k2-thinking");
    expect(thinking).toBeDefined();
    expect(thinking!.input_tokens).toBe(300);
    expect(events.length).toBe(1);
    expect(cursor).toBe("4");
  });

  test("(c) cursor caught up ('4') → no new events, cursor unchanged", () => {
    const { events, cursor } = extractKimiUsageSince(wireText(), "4");
    expect(events.length).toBe(0);
    expect(cursor).toBe("4");
  });

  test("(d) compaction: cursor beyond on-disk count → LAST record only (bounded)", () => {
    const { events, cursor } = extractKimiUsageSince(wireText(), "99");
    // Last record (#3) is all-zero → no events, but cursor re-syncs to '4'.
    expect(events.length).toBe(0);
    expect(cursor).toBe("4");
  });

  test("(d2) compaction with a non-zero last record emits it", () => {
    const text = [
      '{"type":"usage.record","model":"kimi-k2","usage":{"inputOther":111,"output":22,"inputCacheRead":0,"inputCacheCreation":0}}',
    ].join("\n");
    const { events, cursor } = extractKimiUsageSince(text, "50");
    expect(events.length).toBe(1);
    expect(events[0].input_tokens).toBe(111);
    expect(cursor).toBe("1");
  });

  test("(e) empty wire text → no events, cursor preserved", () => {
    const { events, cursor } = extractKimiUsageSince("", "3");
    expect(events.length).toBe(0);
    expect(cursor).toBe("3");
  });

  test("(f) corrupt / partial trailing line is skipped, valid lines still summed", () => {
    const text = wireText() + '{"type":"usage.record","model":"kimi-k2","usage":{"inputOth';
    const { events } = extractKimiUsageSince(text, null);
    const m = byModel(events);
    // The corrupt trailing line is skipped; totals match the clean fixture.
    expect(m.get("kimi-k2")!.input_tokens).toBe(3000);
  });
});
