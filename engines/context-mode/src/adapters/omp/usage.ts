/**
 * adapters/omp/usage — pure parse of an OMP `turn_end` / `agent_end` payload
 * into the {@link buildAgentUsageEvent} counts shape.
 *
 * Ground truth (docs/prds/2026-06-paid-observability/adapter-matrix/omp.md §2-4):
 *   - Per-turn usage rides on `AssistantMessage.usage`
 *     (`refs/platforms/omp/packages/ai/src/types.ts:505-541`).
 *   - The canonical `Usage` shape lives in pi-catalog
 *     (`refs/platforms/omp/packages/catalog/src/types.ts:100-145`): fields
 *     `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, plus a
 *     fully-resolved `cost: { input, output, cacheRead, cacheWrite, total }`
 *     (:138-144) — provider-computed, so NO client price table is needed.
 *   - `model: string` is `provider/model` on the `AssistantMessage` (:510).
 *   - `turn_end` carries `message: AssistantMessage`
 *     (`refs/.../extensibility/shared-events.ts:204-208`); `agent_end` carries
 *     `messages: AssistantMessage[]` (:191-194).
 *
 * Field mapping (matrix §3 → buildAgentUsageEvent input):
 *   Usage.input      → input_tokens
 *   Usage.output     → output_tokens
 *   Usage.cacheWrite → cache_creation_tokens   (cache CREATION on the provider)
 *   Usage.cacheRead  → cache_read_tokens
 *   message.model    → model_id                (the `provider/model` string)
 *   Usage.cost.total → native_cost_usd         (provider-computed, preferred)
 *
 * Algorithmic + null-safe. NO regex. Returns `null` whenever there is no
 * usable signal (no message / no usage / every token bucket absent-or-zero),
 * so a malformed or empty turn emits nothing.
 */

/**
 * The counts object accepted by {@link buildAgentUsageEvent}. Re-declared here
 * (structurally identical) so this module stays a leaf with no import cycle
 * into the heavy `session/extract` module — the handler in `plugin.ts` passes
 * the result straight through to `buildAgentUsageEvent`.
 */
export interface OmpUsageCounts {
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  native_cost_usd: number | null;
}

/** Coerce an unknown to a finite non-negative integer token count, else 0. */
function toTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  // Token counts are integers upstream; floor defensively against floats.
  return Math.floor(value);
}

/** Coerce an unknown to a finite USD cost, else null (so the catalog can fill in). */
function toCostUsd(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

/** Narrow an unknown to a plain (non-null, non-array) object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Resolve the per-turn `AssistantMessage` from a `turn_end` (`.message`) or
 * `agent_end` (`.messages[]`) payload. For `agent_end` we take the LAST
 * assistant message — that is the turn that just completed and whose usage is
 * the new delta (OMP usage is INCREMENTAL per turn, matrix §5).
 */
function resolveMessage(payload: Record<string, unknown>): Record<string, unknown> | null {
  const single = asRecord(payload.message);
  if (single !== null) return single;

  const list = payload.messages;
  if (Array.isArray(list)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = asRecord(list[i]);
      if (m !== null) return m;
    }
  }
  return null;
}

/**
 * Parse an OMP `turn_end` / `agent_end` event payload into the
 * {@link buildAgentUsageEvent} counts shape, or `null` when no usable usage is
 * present. Pure and side-effect free.
 */
export function parseOmpUsage(payload: unknown): OmpUsageCounts | null {
  const root = asRecord(payload);
  if (root === null) return null;

  const message = resolveMessage(root);
  if (message === null) return null;

  const usage = asRecord(message.usage);
  if (usage === null) return null;

  const input_tokens = toTokenCount(usage.input);
  const output_tokens = toTokenCount(usage.output);
  const cache_creation_tokens = toTokenCount(usage.cacheWrite);
  const cache_read_tokens = toTokenCount(usage.cacheRead);

  // No usable token signal → no event (mirrors buildAgentUsageEvent's own
  // all-zero guard, but lets the handler short-circuit before building).
  if (
    input_tokens <= 0 &&
    output_tokens <= 0 &&
    cache_creation_tokens <= 0 &&
    cache_read_tokens <= 0
  ) {
    return null;
  }

  const model_id = typeof message.model === "string" ? message.model : "";

  const cost = asRecord(usage.cost);
  const native_cost_usd = cost !== null ? toCostUsd(cost.total) : null;

  return {
    model_id,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    native_cost_usd,
  };
}
