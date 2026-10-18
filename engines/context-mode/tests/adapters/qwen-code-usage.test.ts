import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseQwenUsage, extractQwenUsageSince, qwenProjectHash, qwenChatJsonlPath } from "../../src/adapters/qwen-code/usage.js";
import { buildAgentUsageEvent } from "../../src/session/extract.js";

/**
 * TDD for qwen-code per-turn token capture via the session-JSONL tail.
 *
 * Fixtures mirror the persisted `ChatRecord` shape (matrix §1,§4;
 * refs chatRecordingService.ts:259,261,919): each record carries `.model` and
 * `.usageMetadata` = GenerateContentResponseUsageMetadata
 * { promptTokenCount, candidatesTokenCount, cachedContentTokenCount,
 *   thoughtsTokenCount, totalTokenCount }, persisted INCREMENTAL per API call.
 *
 * Mapping under test: promptTokenCount→input, candidatesTokenCount→output,
 * thoughtsTokenCount ADDED into output, cachedContentTokenCount→cache_read,
 * model_id = ChatRecord.model. No native cost (catalog-derived).
 */
describe("parseQwenUsage", () => {
  const record = (usageMetadata: unknown, model: unknown = "qwen3-coder-plus", extra: Record<string, unknown> = {}) => ({
    id: "rec-1",
    model,
    usageMetadata,
    ...extra,
  });

  it("maps a full usageMetadata ChatRecord to the builder counts shape", () => {
    const counts = parseQwenUsage(
      record({
        promptTokenCount: 1200,
        candidatesTokenCount: 350,
        thoughtsTokenCount: 80,
        cachedContentTokenCount: 4096,
        totalTokenCount: 5726,
      }),
    );
    expect(counts).toEqual({
      model_id: "qwen3-coder-plus",
      input_tokens: 1200,
      output_tokens: 430, // 350 candidates + 80 thoughts (folded into output)
      cache_creation_tokens: 0, // qwen exposes no cache-creation field
      cache_read_tokens: 4096, // cachedContentTokenCount → cache_read
      native_cost_usd: null, // catalog-derived, no native cost
    });
  });

  it("folds thoughtsTokenCount into output_tokens", () => {
    const counts = parseQwenUsage(record({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 }));
    expect(counts!.output_tokens).toBe(12);
  });

  it("omits cache_read when cachedContentTokenCount is absent", () => {
    const counts = parseQwenUsage(record({ promptTokenCount: 10, candidatesTokenCount: 5 }));
    expect(counts!.cache_read_tokens).toBe(0);
  });

  it("feeds buildAgentUsageEvent → catalog-derived cost (native null)", () => {
    const counts = parseQwenUsage(record({ promptTokenCount: 100, candidatesTokenCount: 50 }));
    expect(counts!.native_cost_usd).toBeNull();
    const ev = buildAgentUsageEvent(counts!);
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe("agent_usage");
    expect(ev!.input_tokens).toBe(100);
    expect(ev!.output_tokens).toBe(50);
    expect(ev!.model_id).toBe("qwen3-coder-plus");
  });

  it("returns empty model_id (not throw) when model is missing", () => {
    const counts = parseQwenUsage({ id: "x", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    expect(counts).not.toBeNull();
    expect(counts!.model_id).toBe("");
  });

  it("floors fractional token counts and clamps negatives to zero", () => {
    const counts = parseQwenUsage(
      record({ promptTokenCount: 10.9, candidatesTokenCount: 5.2, thoughtsTokenCount: -3, cachedContentTokenCount: -4 }),
    );
    expect(counts!.input_tokens).toBe(10);
    expect(counts!.output_tokens).toBe(5); // 5.2 floored, -3 thoughts clamped to 0
    expect(counts!.cache_read_tokens).toBe(0);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["string", "ChatRecord"],
    ["array", [{ usageMetadata: {} }]],
    ["empty object", {}],
    ["record without usageMetadata", { model: "x" }],
    ["usageMetadata not an object", { model: "x", usageMetadata: "nope" }],
    ["all-zero usageMetadata", { model: "x", usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, cachedContentTokenCount: 0, thoughtsTokenCount: 0 } }],
    ["all-absent usageMetadata", { model: "x", usageMetadata: {} }],
  ])("returns null for unusable record: %s", (_label, payload) => {
    expect(parseQwenUsage(payload)).toBeNull();
  });
});

describe("extractQwenUsageSince", () => {
  // Helper: serialize ChatRecords as JSONL (one record per line), interleaving
  // non-usage records (user turns) the way chatRecordingService persists them.
  const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n");

  const usageRec = (id: string, prompt: number, candidates: number, model = "qwen3-coder-plus", extra: Record<string, unknown> = {}) =>
    ({ id, model, usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: candidates }, ...extra });

  it("sums ALL records and returns the last id when cursor is null", () => {
    const text = jsonl(
      { id: "u-1", type: "user", content: "hi" }, // non-usage record, advances cursor
      usageRec("a-1", 100, 50),
      usageRec("a-2", 200, 30),
    );
    const { events, cursor } = extractQwenUsageSince(text, null);
    expect(cursor).toBe("a-2");
    expect(events).toHaveLength(1); // one model
    expect(events[0].input_tokens).toBe(300); // 100 + 200
    expect(events[0].output_tokens).toBe(80); // 50 + 30
  });

  it("emits one event per distinct model", () => {
    const text = jsonl(
      usageRec("a-1", 100, 50, "qwen3-coder-plus"),
      usageRec("a-2", 10, 5, "gemini-2.5-pro"),
    );
    const { events } = extractQwenUsageSince(text, null);
    const byModel = Object.fromEntries(events.map((e) => [e.model_id, e]));
    expect(events).toHaveLength(2);
    expect(byModel["qwen3-coder-plus"].input_tokens).toBe(100);
    expect(byModel["gemini-2.5-pro"].input_tokens).toBe(10);
  });

  it("processes ONLY records strictly after a found cursor (no double-count)", () => {
    const text = jsonl(usageRec("a-1", 100, 50), usageRec("a-2", 200, 30), usageRec("a-3", 7, 3));
    const { events, cursor } = extractQwenUsageSince(text, "a-1");
    expect(cursor).toBe("a-3");
    expect(events[0].input_tokens).toBe(207); // a-2 + a-3, NOT a-1
    expect(events[0].output_tokens).toBe(33);
  });

  it("re-reading after the cursor advances yields no new events (idempotent)", () => {
    const text = jsonl(usageRec("a-1", 100, 50), usageRec("a-2", 200, 30));
    const first = extractQwenUsageSince(text, null);
    expect(first.cursor).toBe("a-2");
    const second = extractQwenUsageSince(text, first.cursor);
    expect(second.events).toHaveLength(0);
    expect(second.cursor).toBe("a-2");
  });

  it("bounded fallback: cursor not found (compaction) processes ONLY the last record", () => {
    const text = jsonl(usageRec("a-2", 200, 30), usageRec("a-3", 7, 3));
    const { events, cursor } = extractQwenUsageSince(text, "a-1-dropped");
    expect(cursor).toBe("a-3");
    expect(events[0].input_tokens).toBe(7); // last record only, NOT the whole history
    expect(events[0].output_tokens).toBe(3);
  });

  it("returns empty + unchanged cursor for empty / whitespace text", () => {
    expect(extractQwenUsageSince("", "a-1")).toEqual({ events: [], cursor: "a-1" });
    expect(extractQwenUsageSince("   \n  ", null)).toEqual({ events: [], cursor: null });
  });

  it("skips malformed JSONL lines without aborting the walk", () => {
    const text = [
      JSON.stringify(usageRec("a-1", 100, 50)),
      "{ this is not json",
      "",
      JSON.stringify(usageRec("a-2", 200, 30)),
    ].join("\n");
    const { events, cursor } = extractQwenUsageSince(text, null);
    expect(cursor).toBe("a-2");
    expect(events[0].input_tokens).toBe(300);
  });

  it("advances cursor past id-bearing non-usage records (e.g. user turns)", () => {
    const text = jsonl(usageRec("a-1", 100, 50), { id: "u-2", type: "user", content: "next" });
    const { cursor } = extractQwenUsageSince(text, null);
    expect(cursor).toBe("u-2"); // last id-bearing record, even though it carried no usage
  });

  it("falls back to messageId when id is absent", () => {
    const text = jsonl({ messageId: "m-1", model: "qwen3-coder-plus", usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1 } });
    const { cursor } = extractQwenUsageSince(text, null);
    expect(cursor).toBe("m-1");
  });
});

describe("qwenProjectHash", () => {
  // Pin against qwen's getProjectHash (paths.ts:262) — raw sha256 hex of the
  // project root, NO salt, so the hash is fully recoverable in the hook.
  it("is sha256 hex of the project root (non-win32)", () => {
    if (process.platform === "win32") return; // win32 lowercases first; covered below
    const root = "/Users/dev/my-project";
    const expected = createHash("sha256").update(root).digest("hex");
    expect(qwenProjectHash(root)).toBe(expected);
    expect(qwenProjectHash(root)).toHaveLength(64);
  });

  it("is deterministic and path-sensitive", () => {
    expect(qwenProjectHash("/a/b")).toBe(qwenProjectHash("/a/b"));
    expect(qwenProjectHash("/a/b")).not.toBe(qwenProjectHash("/a/c"));
  });
});

describe("qwenChatJsonlPath", () => {
  it("builds <qwenHome>/tmp/<hash>/chats/<sessionId>.jsonl", () => {
    const home = "/home/u/.qwen";
    const root = "/work/proj";
    const sid = "sess-abc";
    const hash = qwenProjectHash(root);
    // Build the expected with join() so the assertion is separator-agnostic:
    // qwenChatJsonlPath uses path.join (OS-native), so on win32 the real path
    // uses backslashes — a hard-coded forward-slash literal fails there.
    expect(qwenChatJsonlPath(home, root, sid)).toBe(
      join(home, "tmp", hash, "chats", `${sid}.jsonl`),
    );
  });
});
