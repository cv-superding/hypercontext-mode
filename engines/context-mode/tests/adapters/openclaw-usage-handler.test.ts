/**
 * adapters/openclaw/usage — handleOpenclawUsageEvent.
 *
 * Verifies the parse→build→insert handler the plugin's onDiagnosticEvent
 * listener invokes:
 *   - a real `model.usage` payload is inserted as one `agent_usage` event,
 *   - openclaw's native `costUsd` flows to cost_usd (preferred over catalog),
 *   - the per-turn `usage` total is read, NOT `lastCallUsage`,
 *   - non-usage / zero-usage payloads insert nothing.
 *
 * Ground truth: docs/prds/2026-06-paid-observability/adapter-matrix/openclaw.md
 *   (model.usage @ diagnostic-events.ts:18-47; costUsd pre-computed
 *    agent-runner.ts:1995; usage = per-turn total, lastCallUsage = delta).
 */

import { describe, test, expect } from "vitest";
import { handleOpenclawUsageEvent } from "../../src/adapters/openclaw/usage.js";
import type { SessionEvent } from "../../src/session/extract.js";

describe("handleOpenclawUsageEvent — openclaw model.usage parse→build→insert", () => {
  test("inserts one agent_usage event with native costUsd as cost_usd", () => {
    const inserted: SessionEvent[] = [];
    const ev = handleOpenclawUsageEvent(
      {
        type: "model.usage",
        model: "claude-sonnet-4",
        usage: { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 800 },
        costUsd: 0.0421,
      },
      (e) => inserted.push(e),
    );

    expect(inserted).toHaveLength(1);
    expect(ev).not.toBeNull();
    expect(inserted[0].type).toBe("agent_usage");
    expect(inserted[0].category).toBe("cost");
    expect(inserted[0].model_id).toBe("claude-sonnet-4");
    expect(inserted[0].input_tokens).toBe(1200);
    expect(inserted[0].output_tokens).toBe(340);
    expect(inserted[0].cache_read_tokens).toBe(5000);
    expect(inserted[0].cache_creation_tokens).toBe(800);
    expect(inserted[0].cost_usd).toBe(0.0421); // native, not catalog
  });

  test("reads per-turn `usage`, ignores `lastCallUsage` delta", () => {
    const inserted: SessionEvent[] = [];
    handleOpenclawUsageEvent(
      {
        type: "model.usage",
        model: "claude-sonnet-4",
        usage: { input: 1000, output: 200 },
        lastCallUsage: { input: 999999, output: 999999 },
      },
      (e) => inserted.push(e),
    );
    expect(inserted[0].input_tokens).toBe(1000);
    expect(inserted[0].output_tokens).toBe(200);
  });

  test("non-usage / zero-usage / null payloads insert nothing and return null", () => {
    const inserted: SessionEvent[] = [];
    const push = (e: SessionEvent) => inserted.push(e);
    expect(handleOpenclawUsageEvent(null, push)).toBeNull();
    expect(handleOpenclawUsageEvent({ type: "model.failover" }, push)).toBeNull();
    expect(
      handleOpenclawUsageEvent(
        { type: "model.usage", model: "x", usage: { input: 0, output: 0 } },
        push,
      ),
    ).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  test("insert failure is swallowed (returns null, never throws)", () => {
    expect(() =>
      handleOpenclawUsageEvent(
        { type: "model.usage", model: "x", usage: { input: 10, output: 5 } },
        () => {
          throw new Error("db down");
        },
      ),
    ).not.toThrow();
  });
});
