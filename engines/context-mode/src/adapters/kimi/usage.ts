/**
 * Kimi Code (kimi-code) per-turn token usage capture.
 *
 * Ground truth: context-mode-platform/docs/prds/2026-06-paid-observability/
 * adapter-matrix/kimi.md (+ cited refs/platforms/kimi-code/...).
 *
 * Kimi Code emits REAL per-turn token usage + model, but ONLY on the
 * `wire.jsonl` records stream — NOT through any hook stdin payload. Each usage
 * line is an AgentRecord of `type: "usage.record"` carrying a normalized
 * four-field Moonshot/OpenAI-compatible `TokenUsage` plus the model id:
 *
 *   refs/platforms/kimi-code/packages/agent-core/src/agent/usage/index.ts:27-32
 *     — this.agent.records.logRecord({ type: 'usage.record', model, usage, usageScope })
 *   refs/platforms/kimi-code/packages/agent-core/src/agent/records/types.ts:59-63
 *     — record shape { model: string; usage: TokenUsage; usageScope?: UsageRecordScope }
 *   refs/platforms/kimi-code/packages/agent-core/src/agent/index.ts:142
 *     — new FileSystemAgentRecordPersistence(join(options.homedir, 'wire.jsonl'), ...)
 *       => the persisted file is <sessionDir>/wire.jsonl.
 *
 * Normalized TokenUsage (kosong/src/usage.ts:7-13; parsed by
 * kosong/src/providers/openai-common.ts:213-241):
 *   { inputOther, output, inputCacheRead, inputCacheCreation }
 *
 * Mapping → buildAgentUsageEvent input shape:
 *   inputOther          → input_tokens     (prompt - cached)
 *   output              → output_tokens
 *   inputCacheRead      → cache_read_tokens
 *   inputCacheCreation  → cache_creation_tokens
 *   record.model        → model_id
 *
 * INCREMENTAL: usage.record lines are per-step deltas (summed via addUsage;
 * usage/index.ts:34,37). The cumulative total exists only in-memory, never on
 * disk — so cost capture sums the NEW delta lines per model since a cursor.
 *
 * Native cost: kimi-code's TokenUsage carries NO USD cost field (verified
 * against the matrix doc field list — only token counts). So native_cost_usd
 * is left null and buildAgentUsageEvent falls back to the pricing catalog.
 *
 * Pure, null-safe, algorithmic — NO regex.
 */

import { buildAgentUsageEvent, type AgentUsageCounts, type SessionEvent } from "../../session/extract.js";

/** Non-negative finite number, else 0. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Parse ONE kimi-code `usage.record` line object into the buildAgentUsageEvent
 * input shape, or null when it is not a usage record / carries no usage /
 * every token bucket is zero.
 *
 * Accepts the parsed AgentRecord object (NOT the raw JSONL string). Tolerant of
 * the record being passed either as the full stamped record `{ type, model,
 * usage, ... }` or a bare `{ model, usage }`.
 */
export function parseKimiUsage(record: unknown): AgentUsageCounts | null {
  if (!record || typeof record !== "object") return null;
  const rec = record as Record<string, unknown>;

  // When a `type` discriminator is present it MUST be the usage record kind.
  // Absent type → tolerate (caller may have already narrowed), but a wrong
  // explicit type is rejected so non-usage records never produce cost events.
  if (typeof rec.type === "string" && rec.type !== "usage.record") return null;

  const usageRaw = rec.usage;
  if (!usageRaw || typeof usageRaw !== "object") return null;
  const usage = usageRaw as Record<string, unknown>;

  const input_tokens = num(usage.inputOther);
  const output_tokens = num(usage.output);
  const cache_read_tokens = num(usage.inputCacheRead);
  const cache_creation_tokens = num(usage.inputCacheCreation);

  // Zero-everything record → null (mirrors buildAgentUsageEvent's zero->null
  // contract; keeps the DB free of no-op cost events).
  if (
    input_tokens <= 0 &&
    output_tokens <= 0 &&
    cache_read_tokens <= 0 &&
    cache_creation_tokens <= 0
  ) {
    return null;
  }

  const model_id = typeof rec.model === "string" ? rec.model : "";

  return {
    model_id,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    // kimi-code TokenUsage carries no native USD field — defer to the catalog.
    native_cost_usd: null,
  };
}

/**
 * Cursor-aware wire.jsonl reader for the Stop / SessionEnd hook.
 *
 * `wire.jsonl` is an append-only records stream that grows every turn; the
 * forward loop forwards ALL passed events unconditionally, so re-summing the
 * whole file each hook fire would double-count every prior turn. This sums only
 * the `usage.record` lines NEW since the last fire, keyed by a per-session
 * high-water cursor (a 1-based count of usage.record lines consumed so far,
 * serialized as a decimal string in session_meta.usage_cursor).
 *
 *   - cursor null/empty/unparseable → process ALL usage.record lines.
 *   - cursor = N (>= total)         → nothing new; no events, cursor unchanged.
 *   - cursor = N (< total)          → process usage.record lines AFTER index N.
 *   - BOUNDED COMPACTION FALLBACK: if the file SHRANK below the cursor (the
 *     stream was truncated/rotated, so prior lines are gone), the cursor has
 *     fallen off the front — process ONLY the LAST usage.record line so we
 *     never re-emit the whole history. Mirrors extractTranscriptUsageSince.
 *
 * `cursor` returns the decimal string count of TOTAL usage.record lines seen,
 * so the next fire resumes exactly past it.
 *
 * Per-model summation: lines are bucketed by model_id and each bucket emits one
 * agent_usage event (incremental deltas are additive — addUsage semantics).
 *
 * Char-algorithmic JSONL parse (split on "\n", JSON.parse each line, skip
 * blanks/unparseable). NO regex.
 */
export function extractKimiUsageSince(
  wireJsonlText: string,
  cursor: string | null,
): { events: SessionEvent[]; cursor: string | null } {
  const inputCursor = parseCursor(cursor);

  if (typeof wireJsonlText !== "string" || wireJsonlText.length === 0) {
    // Empty/missing wire file: nothing to process, cursor unchanged.
    return { events: [], cursor: cursor ?? null };
  }

  // Pass 1: materialize the ordered usage.record parse results (one linear
  // walk). We keep the AgentUsageCounts for each usage.record line so the
  // cursor counts ONLY usage records (not unrelated wire lines), making the
  // high-water mark stable against interleaved non-usage records.
  const records: AgentUsageCounts[] = [];
  const lines = wireJsonlText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // partial/corrupt trailing line — skip.
    }
    if (!obj || typeof obj !== "object") continue;
    if ((obj as Record<string, unknown>).type !== "usage.record") continue;
    const parsed = parseKimiUsage(obj);
    // A usage.record that sums to zero still ADVANCES the cursor (it was seen)
    // but contributes no tokens. Push a zero-counts placeholder so the index
    // accounting stays aligned with the on-disk usage.record ordinal.
    records.push(
      parsed ?? {
        model_id: "",
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        native_cost_usd: null,
      },
    );
  }

  const total = records.length;
  if (total === 0) {
    // No usage records at all → nothing to emit, cursor unchanged.
    return { events: [], cursor: cursor ?? null };
  }

  // Select the slice to sum.
  let slice: AgentUsageCounts[];
  if (inputCursor === null || inputCursor <= 0) {
    slice = records; // all usage records
  } else if (inputCursor >= total) {
    if (inputCursor === total) {
      // Caught up exactly — nothing new.
      slice = [];
    } else {
      // Cursor exceeds the on-disk count → the stream shrank (compaction /
      // rotation). Bounded fallback: last usage record only.
      slice = records.slice(total - 1);
    }
  } else {
    slice = records.slice(inputCursor); // strictly after the cursor index
  }

  // Sum the selected records per model and emit via the shared event builder.
  const sums = new Map<string, { input: number; output: number; cacheCreate: number; cacheRead: number }>();
  for (const r of slice) {
    const cur = sums.get(r.model_id) ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    cur.input += r.input_tokens;
    cur.output += r.output_tokens;
    cur.cacheCreate += r.cache_creation_tokens;
    cur.cacheRead += r.cache_read_tokens;
    sums.set(r.model_id, cur);
  }

  const events: SessionEvent[] = [];
  for (const [model, s] of sums) {
    const ev = buildAgentUsageEvent({
      model_id: model,
      input_tokens: s.input,
      output_tokens: s.output,
      cache_creation_tokens: s.cacheCreate,
      cache_read_tokens: s.cacheRead,
    });
    if (ev) events.push(ev);
  }

  // Cursor always advances to the total usage.record count seen, so the next
  // fire resumes past it. Even when the slice produced no events (all-zero or
  // already caught up), the high-water mark moves forward.
  return { events, cursor: String(total) };
}

/** Decimal-string cursor → non-negative integer count, or null when absent/invalid. */
function parseCursor(cursor: string | null): number | null {
  if (typeof cursor !== "string" || cursor.length === 0) return null;
  const n = Number.parseInt(cursor, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
