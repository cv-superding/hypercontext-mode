/**
 * adapters/qwen-code/usage — per-turn token capture from the session JSONL.
 *
 * Qwen Code is a Gemini-CLI fork and normalizes EVERY backend (Gemini-native,
 * OpenAI-compat/DashScope, Anthropic) to the same canonical token shape:
 * `GenerateContentResponseUsageMetadata` { promptTokenCount, candidatesTokenCount,
 * cachedContentTokenCount, thoughtsTokenCount, totalTokenCount }
 * (matrix §1: turn.ts:96,417 + converter.ts:1145-1148). That metadata is
 * persisted, per API call, into the session record file as a `ChatRecord`
 * carrying `.usageMetadata` + `.model`
 * (refs: packages/core/src/services/chatRecordingService.ts:259,261,919 file at
 * ~/.qwen/tmp/<project_id>/chats/<sessionId>.jsonl — :451 location comment,
 * :600,628-629 path build).
 *
 * CRITICAL (matrix §4): qwen-code's hook payloads carry tool I/O ONLY — token
 * usage is unreachable through the hook stream (grep of hookEventHandler.ts /
 * hookSystem.ts / toolHookTriggers.ts for token|usageMetadata|usage → zero
 * matches). The ONLY live capture path is a tail of the session JSONL. This
 * module is therefore the JSONL-tail counterpart to claude-code's
 * `extractTranscriptUsageSince` (src/session/extract.ts) — same cursor-gated,
 * char-algorithmic, NO-regex parse, same `buildAgentUsageEvent` emission path.
 *
 * Per matrix §3 each ChatRecord.usageMetadata is INCREMENTAL per API call
 * (cumulative session totals are derived downstream via += in
 * uiTelemetry.ts:237-241), so summing the NEW records since the cursor yields
 * the exact billed delta with no double-count.
 *
 * No native USD — cost_usd is derived from the pricing catalog inside
 * buildAgentUsageEvent (native_cost_usd omitted). Pure, null-safe, NO regex.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { platform } from "node:os";

import { buildAgentUsageEvent, type AgentUsageCounts, type SessionEvent } from "../../session/extract.js";

/** Floor-and-clamp a token field to a non-negative integer (mirrors omp/usage). */
function tokenNum(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  const n = Math.floor(v);
  return n > 0 ? n : 0;
}

/**
 * Parse ONE qwen `ChatRecord` into the `buildAgentUsageEvent` input shape, or
 * null when the record carries no usage / sums to zero.
 *
 * Mapping → builder shape (AgentUsageCounts):
 *   promptTokenCount        → input_tokens
 *   candidatesTokenCount    → output_tokens
 *   thoughtsTokenCount      → ADDED into output_tokens (Gemini-lineage bills
 *                             reasoning/thoughts as output — same fold as
 *                             parseGeminiUsage in src/session/extract.ts)
 *   cachedContentTokenCount → cache_read_tokens (when present)
 *   model_id                → ChatRecord.model
 *
 * No native cost — native_cost_usd omitted (catalog-derived). NO regex.
 */
export function parseQwenUsage(record: unknown): AgentUsageCounts | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const rec = record as Record<string, unknown>;

  const um = rec.usageMetadata;
  if (!um || typeof um !== "object") return null;
  const usage = um as Record<string, unknown>;

  const input = tokenNum(usage.promptTokenCount);
  const candidates = tokenNum(usage.candidatesTokenCount);
  const thoughts = tokenNum(usage.thoughtsTokenCount);
  const cached = tokenNum(usage.cachedContentTokenCount);
  // Gemini-lineage bills reasoning (thoughts) as output tokens — fold into output.
  const output = candidates + thoughts;

  // All token fields zero → not a billable record. buildAgentUsageEvent would
  // also reject this, but short-circuit keeps the contract explicit.
  if (input <= 0 && output <= 0 && cached <= 0) return null;

  const model_id = typeof rec.model === "string" ? rec.model : "";

  return {
    model_id,
    input_tokens: input,
    output_tokens: output,
    cache_creation_tokens: 0, // qwen exposes no cache-creation field
    cache_read_tokens: cached,
    native_cost_usd: null, // catalog-derived (no native cost on qwen records)
  };
}

/** Stable cursor identity for a ChatRecord: prefer `id`, fall back to `messageId`. */
function recordId(rec: Record<string, unknown>): string | null {
  if (typeof rec.id === "string" && rec.id.length > 0) return rec.id;
  if (typeof rec.messageId === "string" && rec.messageId.length > 0) return rec.messageId;
  return null;
}

/**
 * Cursor-aware tail of the qwen session JSONL. Emits one priced `agent_usage`
 * event PER distinct model across the records NEW since `cursor`, so re-reading
 * the (append-only, ever-growing) JSONL each Stop never double-counts.
 *
 *   - cursor null/empty            → process ALL records.
 *   - cursor found                 → process records STRICTLY AFTER it.
 *   - cursor set but NOT found     → compaction/rotation dropped it: bounded
 *     fallback processes ONLY THE LAST record (never re-emit full history).
 *
 * `cursor` returns the id of the LAST id-bearing record seen (whether or not it
 * carried usage), so the next call resumes exactly past it. When no record
 * carries an id, the input cursor is returned unchanged.
 *
 * One linear walk, JSON.parse per line, NO regex — mirrors
 * extractTranscriptUsageSince's structure exactly.
 */
export function extractQwenUsageSince(
  jsonlText: string,
  cursor: string | null,
): { events: SessionEvent[]; cursor: string | null } {
  const inputCursor = typeof cursor === "string" && cursor.length > 0 ? cursor : null;
  if (typeof jsonlText !== "string" || jsonlText.length === 0) {
    return { events: [], cursor: inputCursor };
  }

  // Pass 1: materialize the ordered records (parsed object + counts + id). One
  // linear newline walk — no array allocation per char, no regex.
  type Row = { id: string | null; counts: AgentUsageCounts | null };
  const rows: Row[] = [];
  let start = 0;
  for (let i = 0; i <= jsonlText.length; i++) {
    if (i !== jsonlText.length && jsonlText.charCodeAt(i) !== 10 /* \n */) continue;
    const line = jsonlText.slice(start, i).trim();
    start = i + 1;
    if (line.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      const p = JSON.parse(line);
      if (!p || typeof p !== "object" || Array.isArray(p)) continue;
      obj = p as Record<string, unknown>;
    } catch {
      continue;
    }
    rows.push({ id: recordId(obj), counts: parseQwenUsage(obj) });
  }

  if (rows.length === 0) return { events: [], cursor: inputCursor };

  // Cursor always advances to the last id-bearing record's id (or stays as the
  // input cursor when no record carries an id).
  let lastId: string | null = inputCursor;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].id !== null) { lastId = rows[i].id; break; }
  }

  // Select the slice to sum.
  let slice: Row[];
  if (inputCursor === null) {
    slice = rows; // all records
  } else {
    let foundAt = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].id === inputCursor) { foundAt = i; break; }
    }
    if (foundAt >= 0) {
      slice = rows.slice(foundAt + 1); // strictly after the cursor
    } else {
      // Compaction/rotation: cursor fell off the front. Bounded fallback — last
      // record only. Never re-emit the whole history.
      slice = rows.slice(rows.length - 1);
    }
  }

  // Sum the selected records per model, then emit via the shared builder.
  const sums = new Map<string, { input: number; output: number; cacheCreate: number; cacheRead: number }>();
  for (const row of slice) {
    const c = row.counts;
    if (!c) continue;
    const cur = sums.get(c.model_id) ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    cur.input += c.input_tokens;
    cur.output += c.output_tokens;
    cur.cacheCreate += c.cache_creation_tokens;
    cur.cacheRead += c.cache_read_tokens;
    sums.set(c.model_id, cur);
  }

  const events: SessionEvent[] = [];
  for (const [model_id, s] of sums) {
    const ev = buildAgentUsageEvent({
      model_id,
      input_tokens: s.input,
      output_tokens: s.output,
      cache_creation_tokens: s.cacheCreate,
      cache_read_tokens: s.cacheRead,
    });
    if (ev) events.push(ev);
  }

  return { events, cursor: lastId };
}

/**
 * Hash a project root into qwen-code's `<project_id>` directory segment.
 *
 * EXACT port of qwen's `getProjectHash`
 * (refs/platforms/qwen-code/packages/core/src/utils/paths.ts:262 —
 * `crypto.createHash('sha256').update(normalizedPath).digest('hex')`). On
 * Windows qwen lowercases the path first (case-insensitive FS); we mirror that
 * so a hook running on win32 resolves the same tmp dir qwen itself wrote.
 * Pure, deterministic, NO regex.
 */
export function qwenProjectHash(projectRoot: string): string {
  const normalized = platform() === "win32" ? projectRoot.toLowerCase() : projectRoot;
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Build the canonical session JSONL path qwen-code writes its ChatRecords to:
 *   <qwenHome>/tmp/<sha256(projectRoot)>/chats/<sessionId>.jsonl
 * (refs chatRecordingService.ts:451 location + storage.ts:316-320
 * getProjectTempDir → getGlobalTempDir(<qwenHome>/tmp) + getProjectHash).
 *
 * `qwenHome` is normally `<homedir>/.qwen`. Pure path join — does NOT touch the
 * FS, so it is fully unit-testable; existence probing + the glob fallback live
 * in the Stop hook (which cannot import this TS at runtime). NO regex.
 */
export function qwenChatJsonlPath(qwenHome: string, projectRoot: string, sessionId: string): string {
  return join(qwenHome, "tmp", qwenProjectHash(projectRoot), "chats", `${sessionId}.jsonl`);
}
