/**
 * parsePiUsage — Pi (oh-my-pi) per-turn token+cost capture.
 *
 * Ground truth: context-mode-platform/docs/prds/2026-06-paid-observability/
 * adapter-matrix/pi.md (refs @320261f). Pi surfaces per-turn usage on
 * AssistantMessage.usage (input/output/cacheRead/cacheWrite) plus native USD
 * on usage.cost.total, with model on AssistantMessage.model. Delivered via the
 * `turn_end` hook as TurnEndEvent.message.
 *
 * These tests pin the field mapping, native-USD pass-through, and zero->null
 * contract before the value flows into buildAgentUsageEvent. NO regex; pure
 * algorithmic parse.
 */

import { describe, it, expect } from "vitest";
import { parsePiUsage, buildAgentUsageEvent } from "../../src/session/extract.js";

/** Minimal Pi turn_end payload fixture (shape per shared-events.ts:204-209). */
function turnEnd(overrides?: {
  model?: string;
  usage?: Record<string, unknown>;
  role?: string;
}) {
  return {
    type: "turn_end",
    turnIndex: 3,
    message: {
      role: overrides?.role ?? "assistant",
      model: overrides?.model ?? "openrouter/anthropic/claude-sonnet-4",
      usage: overrides?.usage ?? {
        input: 1200,
        output: 340,
        cacheWrite: 80,
        cacheRead: 4096,
        totalTokens: 5716,
        cost: {
          input: 0.0036,
          output: 0.0051,
          cacheRead: 0.0012,
          cacheWrite: 0.0003,
          total: 0.0102,
        },
      },
    },
    toolResults: [],
  };
}

describe("parsePiUsage", () => {
  it("maps Pi usage fields to the buildAgentUsageEvent shape", () => {
    const counts = parsePiUsage(turnEnd());
    expect(counts).not.toBeNull();
    expect(counts).toEqual({
      model_id: "openrouter/anthropic/claude-sonnet-4",
      input_tokens: 1200,
      output_tokens: 340,
      cache_creation_tokens: 80, // cacheWrite -> cache_creation_tokens
      cache_read_tokens: 4096, // cacheRead   -> cache_read_tokens
      native_cost_usd: 0.0102, // usage.cost.total
    });
  });

  it("keeps the provider/model id intact (builder normalizes downstream)", () => {
    const counts = parsePiUsage(turnEnd({ model: "openrouter/x-ai/grok-2" }));
    expect(counts?.model_id).toBe("openrouter/x-ai/grok-2");
  });

  it("accepts a bare AssistantMessage (event.message) as well as the full event", () => {
    const full = turnEnd();
    const bare = parsePiUsage(full.message);
    expect(bare).toEqual(parsePiUsage(full));
  });

  it("flows the native USD cost through buildAgentUsageEvent as cost_usd", () => {
    const counts = parsePiUsage(turnEnd());
    const ev = buildAgentUsageEvent(counts!);
    expect(ev).not.toBeNull();
    expect(ev!.cost_usd).toBe(0.0102);
    expect(ev!.model_id).toBe("openrouter/anthropic/claude-sonnet-4");
    expect(ev!.input_tokens).toBe(1200);
    expect(ev!.output_tokens).toBe(340);
    expect(ev!.cache_creation_tokens).toBe(80);
    expect(ev!.cache_read_tokens).toBe(4096);
  });

  it("omits native cost when usage.cost.total is absent (catalog fallback)", () => {
    const counts = parsePiUsage(
      turnEnd({ usage: { input: 100, output: 50 } }),
    );
    expect(counts?.native_cost_usd).toBeNull();
  });

  it("returns null when every token bucket is zero/absent", () => {
    expect(
      parsePiUsage(
        turnEnd({
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        }),
      ),
    ).toBeNull();
  });

  it("returns null for an all-zero turn so no no-op event is emitted", () => {
    const counts = parsePiUsage(
      turnEnd({ usage: { input: 0, output: 0 } }),
    );
    // parse -> null; even if a caller forced a zero shape, build also returns null.
    expect(counts).toBeNull();
  });

  it("skips non-assistant turns (custom/non-LLM messages have no usage)", () => {
    expect(parsePiUsage(turnEnd({ role: "user" }))).toBeNull();
    expect(parsePiUsage(turnEnd({ role: "custom" }))).toBeNull();
  });

  it("tolerates a missing role when usage is present", () => {
    const payload = {
      message: { model: "openrouter/anthropic/claude-sonnet-4", usage: { input: 10, output: 5 } },
    };
    const counts = parsePiUsage(payload);
    expect(counts?.input_tokens).toBe(10);
    expect(counts?.output_tokens).toBe(5);
  });

  it("is null-safe for malformed payloads", () => {
    expect(parsePiUsage(null)).toBeNull();
    expect(parsePiUsage(undefined)).toBeNull();
    expect(parsePiUsage(42)).toBeNull();
    expect(parsePiUsage("nope")).toBeNull();
    expect(parsePiUsage({})).toBeNull();
    expect(parsePiUsage({ message: {} })).toBeNull();
    expect(parsePiUsage({ message: { role: "assistant", usage: null } })).toBeNull();
    expect(parsePiUsage({ message: { role: "assistant", usage: 7 } })).toBeNull();
  });

  it("ignores non-finite / negative token values", () => {
    const counts = parsePiUsage(
      turnEnd({
        usage: {
          input: Number.NaN,
          output: -5,
          cacheRead: Infinity,
          cacheWrite: 3,
        },
      }),
    );
    // only cacheWrite (3) is a valid positive finite number
    expect(counts).toEqual({
      model_id: "openrouter/anthropic/claude-sonnet-4",
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 3,
      cache_read_tokens: 0,
      native_cost_usd: null,
    });
  });

  it("defaults model_id to empty string when model is missing", () => {
    const counts = parsePiUsage({
      message: { role: "assistant", usage: { input: 10, output: 5 } },
    });
    expect(counts?.model_id).toBe("");
  });

  it("ignores a non-finite usage.cost.total", () => {
    const counts = parsePiUsage(
      turnEnd({ usage: { input: 10, output: 5, cost: { total: Number.NaN } } }),
    );
    expect(counts?.native_cost_usd).toBeNull();
  });
});
