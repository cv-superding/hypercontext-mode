import { describe, it, expect } from "vitest";
import { parseOmpUsage } from "../../src/adapters/omp/usage.js";
import { buildAgentUsageEvent } from "../../src/session/extract.js";

/**
 * TDD for the OMP per-turn token+cost capture parse.
 *
 * Fixtures mirror the upstream `turn_end` shape: `{ type, message }` where
 * `message` is an `AssistantMessage` carrying `model: "provider/model"` and
 * `usage: Usage` (input/output/cacheRead/cacheWrite + nested cost.total).
 * Refs: refs/platforms/omp/packages/{ai/src/types.ts:505-541,
 * catalog/src/types.ts:100-145}, extensibility/shared-events.ts:204-208.
 */
describe("parseOmpUsage", () => {
  const turnEnd = (usage: unknown, model: unknown = "anthropic/claude-sonnet-4-5") => ({
    type: "turn_end",
    message: { model, usage },
  });

  it("maps a full turn_end Usage to the builder counts shape", () => {
    const counts = parseOmpUsage(
      turnEnd({
        input: 1200,
        output: 350,
        cacheWrite: 64,
        cacheRead: 4096,
        totalTokens: 5710,
        cost: { input: 0.0036, output: 0.00525, cacheRead: 0.001, cacheWrite: 0.0002, total: 0.01005 },
      }),
    );
    expect(counts).toEqual({
      model_id: "anthropic/claude-sonnet-4-5",
      input_tokens: 1200,
      output_tokens: 350,
      cache_creation_tokens: 64, // cacheWrite → creation
      cache_read_tokens: 4096, // cacheRead → read
      native_cost_usd: 0.01005, // cost.total preferred
    });
  });

  it("feeds buildAgentUsageEvent so native cost is preferred over the catalog", () => {
    const counts = parseOmpUsage(
      turnEnd({ input: 100, output: 50, cacheWrite: 0, cacheRead: 0, cost: { total: 0.0042 } }),
    );
    expect(counts).not.toBeNull();
    const ev = buildAgentUsageEvent(counts!);
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("agent_usage");
    expect(ev!.cost_usd).toBe(0.0042);
    expect(ev!.input_tokens).toBe(100);
    expect(ev!.output_tokens).toBe(50);
    expect(ev!.model_id).toBe("anthropic/claude-sonnet-4-5");
    expect(ev!.data).toContain("cost_usd:");
  });

  it("falls back to catalog cost (native null) when usage has no cost object", () => {
    const counts = parseOmpUsage(turnEnd({ input: 100, output: 50 }));
    expect(counts).not.toBeNull();
    expect(counts!.native_cost_usd).toBeNull();
  });

  it("treats a non-finite or negative cost.total as no native cost", () => {
    expect(
      parseOmpUsage(turnEnd({ input: 10, output: 5, cost: { total: Number.NaN } }))!.native_cost_usd,
    ).toBeNull();
    expect(
      parseOmpUsage(turnEnd({ input: 10, output: 5, cost: { total: -1 } }))!.native_cost_usd,
    ).toBeNull();
  });

  it("resolves the LAST assistant message for an agent_end payload", () => {
    const counts = parseOmpUsage({
      type: "agent_end",
      messages: [
        { model: "anthropic/old", usage: { input: 1, output: 1 } },
        { model: "anthropic/claude-opus", usage: { input: 9, output: 3, cost: { total: 0.02 } } },
      ],
    });
    expect(counts).not.toBeNull();
    expect(counts!.model_id).toBe("anthropic/claude-opus");
    expect(counts!.input_tokens).toBe(9);
    expect(counts!.native_cost_usd).toBe(0.02);
  });

  it("returns empty model_id (not throw) when model is missing", () => {
    // Build the message without a `model` key at all (the turnEnd helper would
    // substitute its default), exercising the typeof-string guard in parse.
    const counts = parseOmpUsage({ type: "turn_end", message: { usage: { input: 10, output: 5 } } });
    expect(counts).not.toBeNull();
    expect(counts!.model_id).toBe("");
  });

  it("floors fractional token counts and clamps negatives to zero", () => {
    const counts = parseOmpUsage(turnEnd({ input: 10.9, output: 5.2, cacheRead: -4, cacheWrite: 3.7 }));
    expect(counts!.input_tokens).toBe(10);
    expect(counts!.output_tokens).toBe(5);
    expect(counts!.cache_read_tokens).toBe(0);
    expect(counts!.cache_creation_tokens).toBe(3);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["string", "turn_end"],
    ["array", [{ message: {} }]],
    ["empty object", {}],
    ["message without usage", { message: { model: "x" } }],
    ["usage not an object", { message: { model: "x", usage: "nope" } }],
    ["all-zero usage", { message: { model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }],
    ["all-absent usage", { message: { model: "x", usage: {} } }],
    ["agent_end empty messages", { messages: [] }],
  ])("returns null for unusable payload: %s", (_label, payload) => {
    expect(parseOmpUsage(payload)).toBeNull();
  });
});
