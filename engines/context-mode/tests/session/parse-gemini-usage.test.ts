/**
 * gemini-cli AfterModel usage capture — parseGeminiUsage.
 *
 * Ground truth: docs/prds/2026-06-paid-observability/adapter-matrix/gemini-cli.md
 *   - AfterModel hook payload carries `llm_request` + `llm_response`
 *     (gemini-cli packages/core/src/hooks/types.ts:692-695).
 *   - `llm_response.usageMetadata` exposes promptTokenCount /
 *     candidatesTokenCount / totalTokenCount (hookTranslator.ts:60-64).
 *     CAVEAT: the decoupled hook payload DROPS cachedContentTokenCount and
 *     thoughtsTokenCount — so we map them defensively WHEN PRESENT (a richer
 *     payload variant or a future fix), but never depend on them.
 *   - model_id = response.modelVersion || req.model
 *     (loggingContentGenerator.ts:405,553).
 *
 * Mapping under test:
 *   promptTokenCount        -> input_tokens
 *   candidatesTokenCount    -> output_tokens
 *   thoughtsTokenCount      -> ADDED into output_tokens (reasoning billed as output)
 *   cachedContentTokenCount -> cache_read_tokens (when present)
 *   model_id                -> resolved model
 *
 * NO regex. Pure, null-safe, algorithmic.
 */

import { describe, test, expect } from "vitest";
import { parseGeminiUsage } from "../../src/session/extract.js";

describe("parseGeminiUsage — gemini-cli AfterModel usageMetadata", () => {
  test("tracer: prompt+candidates+model maps to a builder agent_usage event", () => {
    const ev = parseGeminiUsage({
      llm_request: { model: "gemini-2.5-pro" },
      llm_response: {
        usageMetadata: {
          promptTokenCount: 1200,
          candidatesTokenCount: 340,
          totalTokenCount: 1540,
        },
      },
    });
    expect(ev).not.toBeNull();
    expect(ev?.type).toBe("agent_usage");
    expect(ev?.category).toBe("cost");
    expect(ev?.model_id).toBe("gemini-2.5-pro");
    expect(ev?.input_tokens).toBe(1200);
    expect(ev?.output_tokens).toBe(340);
  });

  test("thoughtsTokenCount is ADDED into output_tokens (reasoning billed as output)", () => {
    const ev = parseGeminiUsage({
      llm_request: { model: "gemini-2.5-pro" },
      llm_response: {
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          thoughtsTokenCount: 25,
        },
      },
    });
    expect(ev?.input_tokens).toBe(100);
    expect(ev?.output_tokens).toBe(75); // 50 candidates + 25 thoughts
  });

  test("cachedContentTokenCount maps to cache_read_tokens when present", () => {
    const ev = parseGeminiUsage({
      llm_request: { model: "gemini-2.5-flash" },
      llm_response: {
        usageMetadata: {
          promptTokenCount: 800,
          candidatesTokenCount: 120,
          cachedContentTokenCount: 256,
        },
      },
    });
    expect(ev?.cache_read_tokens).toBe(256);
    expect(ev?.input_tokens).toBe(800);
  });

  test("model resolves response.modelVersion over request.model", () => {
    const ev = parseGeminiUsage({
      llm_request: { model: "gemini-2.5-pro" },
      llm_response: {
        modelVersion: "gemini-2.5-pro-002",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    });
    expect(ev?.model_id).toBe("gemini-2.5-pro-002");
  });

  test("missing cached/thoughts (real AfterModel payload) still produces a valid event", () => {
    const ev = parseGeminiUsage({
      llm_request: { model: "gemini-2.5-flash" },
      llm_response: {
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 200 },
      },
    });
    expect(ev?.input_tokens).toBe(500);
    expect(ev?.output_tokens).toBe(200);
    expect(ev?.cache_read_tokens).toBeUndefined();
  });

  test("null-safe: returns null on absent payload / usageMetadata / all-zero", () => {
    expect(parseGeminiUsage(null)).toBeNull();
    expect(parseGeminiUsage(undefined)).toBeNull();
    expect(parseGeminiUsage({})).toBeNull();
    expect(parseGeminiUsage({ llm_response: {} })).toBeNull();
    expect(parseGeminiUsage({ llm_response: { usageMetadata: {} } })).toBeNull();
    expect(
      parseGeminiUsage({
        llm_request: { model: "gemini-2.5-pro" },
        llm_response: {
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
        },
      }),
    ).toBeNull();
  });

  test("non-numeric token fields are ignored (defensive coercion, no NaN)", () => {
    const ev = parseGeminiUsage({
      llm_request: { model: "gemini-2.5-pro" },
      llm_response: {
        usageMetadata: {
          promptTokenCount: "1200" as unknown as number,
          candidatesTokenCount: 340,
          thoughtsTokenCount: null as unknown as number,
        },
      },
    });
    // promptTokenCount is a string -> ignored (0); candidates valid.
    expect(ev?.input_tokens).toBe(0);
    expect(ev?.output_tokens).toBe(340);
  });
});
