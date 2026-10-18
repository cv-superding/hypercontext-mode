/**
 * openclaw model.usage diagnostic-event capture — parseOpenclawUsage.
 *
 * Ground truth: docs/prds/2026-06-paid-observability/adapter-matrix/openclaw.md
 *   - openclaw emits a first-class `model.usage` diagnostic event
 *     (`DiagnosticUsageEvent`) once per turn, consumed via
 *     `onDiagnosticEvent(listener)`
 *     (refs/platforms/openclaw/src/infra/diagnostic-events.ts:1156).
 *   - Event shape (diagnostic-events.ts:18-47):
 *       { type:"model.usage", model?, provider?, costUsd?,
 *         usage:{ input?, output?, cacheRead?, cacheWrite?, promptTokens?, total? },
 *         lastCallUsage:{...delta},  context:{...} }
 *   - `usage` is the PER-TURN TOTAL ("Last Turn Total" agent-runner.ts:943);
 *     `lastCallUsage` is the last-model-call DELTA — consume `usage`, NEVER
 *     sum lastCallUsage (matrix: incremental_or_cumulative).
 *   - `costUsd` is PRE-COMPUTED by openclaw via estimateUsageCost
 *     (agent-runner.ts:1995, shipped diagnostic-events.ts:45) — flows to
 *     native_cost_usd, preferred over the catalog.
 *
 * Mapping under test (openclaw → AgentUsageCounts):
 *   usage.input     -> input_tokens
 *   usage.output    -> output_tokens
 *   usage.cacheWrite-> cache_creation_tokens   (cache-creation)
 *   usage.cacheRead -> cache_read_tokens       (cache-read)
 *   evt.costUsd     -> native_cost_usd
 *   evt.model       -> model_id
 *
 * NO regex. Pure, null-safe, algorithmic.
 */

import { describe, test, expect } from "vitest";
import { parseOpenclawUsage, buildAgentUsageEvent } from "../../src/session/extract.js";

describe("parseOpenclawUsage — openclaw model.usage diagnostic event", () => {
  test("tracer: full usage breakdown + model maps to builder counts", () => {
    const counts = parseOpenclawUsage({
      type: "model.usage",
      provider: "anthropic",
      model: "claude-sonnet-4",
      usage: {
        input: 1200,
        output: 340,
        cacheRead: 5000,
        cacheWrite: 800,
        promptTokens: 7000,
        total: 7340,
      },
      costUsd: 0.0421,
    });
    expect(counts).not.toBeNull();
    expect(counts?.model_id).toBe("claude-sonnet-4");
    expect(counts?.input_tokens).toBe(1200);
    expect(counts?.output_tokens).toBe(340);
    expect(counts?.cache_creation_tokens).toBe(800); // cacheWrite -> cache_creation
    expect(counts?.cache_read_tokens).toBe(5000); // cacheRead -> cache_read
    expect(counts?.native_cost_usd).toBe(0.0421);
  });

  test("native costUsd flows through to cost_usd on the built event (preferred over catalog)", () => {
    const counts = parseOpenclawUsage({
      type: "model.usage",
      model: "claude-sonnet-4",
      usage: { input: 1000, output: 200 },
      costUsd: 0.0099,
    });
    const ev = buildAgentUsageEvent(counts!);
    expect(ev).not.toBeNull();
    expect(ev?.type).toBe("agent_usage");
    expect(ev?.category).toBe("cost");
    expect(ev?.cost_usd).toBe(0.0099); // native cost wins, NOT a catalog computation
  });

  test("lastCallUsage is NOT consumed — only the per-turn `usage` total is read", () => {
    const counts = parseOpenclawUsage({
      type: "model.usage",
      model: "claude-sonnet-4",
      usage: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 },
      lastCallUsage: { input: 999999, output: 999999, cacheRead: 999999, cacheWrite: 999999 },
    });
    // Values come from `usage`, never from the lastCallUsage delta.
    expect(counts?.input_tokens).toBe(1000);
    expect(counts?.output_tokens).toBe(200);
    expect(counts?.cache_read_tokens).toBe(50);
    expect(counts?.cache_creation_tokens).toBe(10);
  });

  test("absent costUsd -> native_cost_usd null (builder falls back to catalog)", () => {
    const counts = parseOpenclawUsage({
      type: "model.usage",
      model: "claude-sonnet-4",
      usage: { input: 500, output: 120 },
    });
    expect(counts?.native_cost_usd).toBeNull();
  });

  test("partial usage (only input/output) still produces valid counts", () => {
    const counts = parseOpenclawUsage({
      type: "model.usage",
      model: "gpt-5",
      usage: { input: 800, output: 60 },
    });
    expect(counts?.input_tokens).toBe(800);
    expect(counts?.output_tokens).toBe(60);
    expect(counts?.cache_creation_tokens).toBe(0);
    expect(counts?.cache_read_tokens).toBe(0);
  });

  test("null-safe: returns null on absent payload / usage / wrong type / all-zero", () => {
    expect(parseOpenclawUsage(null)).toBeNull();
    expect(parseOpenclawUsage(undefined)).toBeNull();
    expect(parseOpenclawUsage({})).toBeNull();
    // wrong diagnostic type → not a usage event
    expect(
      parseOpenclawUsage({ type: "model.failover", usage: { input: 10 } }),
    ).toBeNull();
    // missing usage object
    expect(parseOpenclawUsage({ type: "model.usage", model: "x" })).toBeNull();
    // all-zero usage → null (no no-op cost row)
    expect(
      parseOpenclawUsage({
        type: "model.usage",
        model: "x",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toBeNull();
  });

  test("non-numeric / non-finite token fields are coerced to 0 (no NaN)", () => {
    const counts = parseOpenclawUsage({
      type: "model.usage",
      model: "claude-sonnet-4",
      usage: {
        input: "1200" as unknown as number,
        output: 340,
        cacheRead: Number.NaN as unknown as number,
        cacheWrite: null as unknown as number,
      },
      costUsd: "nope" as unknown as number,
    });
    expect(counts?.input_tokens).toBe(0); // string -> ignored
    expect(counts?.output_tokens).toBe(340);
    expect(counts?.cache_read_tokens).toBe(0); // NaN -> ignored
    expect(counts?.cache_creation_tokens).toBe(0); // null -> ignored
    expect(counts?.native_cost_usd).toBeNull(); // non-finite cost -> null
  });

  test("missing model is tolerated -> empty model_id (builder still emits)", () => {
    const counts = parseOpenclawUsage({
      type: "model.usage",
      usage: { input: 10, output: 5 },
    });
    expect(counts).not.toBeNull();
    expect(counts?.model_id).toBe("");
  });
});
