/**
 * Pricing catalog — single source of truth for per-model USD cost.
 *
 * Deep module, tiny interface. At load it reads one curated multi-vendor JSON
 * (src/session/model-prices.json) into a Map<modelId, Price> in per-Mtok units,
 * then exposes three pure-ish functions:
 *
 *   lookupPrice(modelId)            → Price | null
 *   computeCostUsd(modelId, tokens) → number  | null
 *   nativeOrComputed(id, t, native) → number  | null
 *
 * WHY THIS EXISTS — the bug it kills:
 * The old table in src/session/extract.ts hardcoded ~5 Claude rows plus a
 * `default` row, and any unmatched id (every OpenAI / Gemini / Qwen / DeepSeek
 * / Grok model) silently inherited Claude-Sonnet pricing. Non-Claude turns were
 * therefore mispriced. Here each model is priced from ITS OWN curated row, and
 * an unknown id resolves to `null` (no price) instead of a wrong Claude rate.
 *
 * The large litellm catalog (~1.5MB, ~2900 models) is NOT bundled — it lives at
 * tools/pricing/litellm-catalog.json as the dev-only refresh base for this
 * curated JSON.
 *
 * The curated JSON is small (~13KB, 61 models) and esbuild inlines it into the
 * hook/server bundles at build time (no runtime fs read, no external file).
 */

import catalog from "./model-prices.json" with { type: "json" };

/** Per-Mtok price for one model. Any of the four rates may be null ("unknown"). */
export interface Price {
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  cache_read_per_mtok: number | null;
  cache_write_per_mtok: number | null;
}

/** Token counts for one turn. All fields optional; absent ⇒ treated as 0. */
export interface TokenCounts {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

/** Raw shape of a curated source row (carries a provenance `source` we drop). */
interface RawRow {
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  cache_read_per_mtok: number | null;
  cache_write_per_mtok: number | null;
  [extra: string]: unknown;
}

/**
 * Read the curated JSON into one Map. A row with a null *input* price is
 * unusable for cost (the primary bucket has no rate) and is dropped at load so
 * lookupPrice returns null for it — matching "null-priced entries → no price".
 * (The two null-input ids are already pruned from the JSON itself; this guard
 * keeps the loader robust if one is ever re-added.)
 */
function buildCatalog(): Map<string, Price> {
  const map = new Map<string, Price>();
  const src = catalog as Record<string, RawRow>;
  for (const id of Object.keys(src)) {
    const row = src[id];
    if (row == null || typeof row !== "object") continue;
    // No input rate ⇒ no usable price for this model.
    if (typeof row.input_per_mtok !== "number") continue;
    map.set(id, {
      input_per_mtok: row.input_per_mtok,
      output_per_mtok: typeof row.output_per_mtok === "number" ? row.output_per_mtok : null,
      cache_read_per_mtok:
        typeof row.cache_read_per_mtok === "number" ? row.cache_read_per_mtok : null,
      cache_write_per_mtok:
        typeof row.cache_write_per_mtok === "number" ? row.cache_write_per_mtok : null,
    });
  }
  return map;
}

const CATALOG: Map<string, Price> = buildCatalog();

/**
 * Strip a single leading `provider/` segment, char-algorithmically (NO regex).
 * Walks to the first '/'; everything after it is the bare model id. Only the
 * FIRST segment is stripped — `openai/gpt-5` → `gpt-5`, `a/b/c` → `b/c` — so a
 * model id that legitimately contains a slash keeps its remaining segments.
 * Returns null when there is no '/' (caller already tried the raw form).
 */
function stripProviderPrefix(id: string): string | null {
  for (let i = 0; i < id.length; i++) {
    if (id.charCodeAt(i) === 47 /* '/' */) {
      // Guard against a leading or trailing slash producing an empty segment.
      if (i === 0 || i === id.length - 1) return null;
      return id.slice(i + 1);
    }
  }
  return null;
}

/** trim + lowercase, char-safe (String.prototype.trim/toLowerCase, no regex). */
function normalize(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Resolve a model id to its curated Price, or null on miss.
 * Strategy: exact, then normalized (trim+lowercase), then provider-stripped
 * normalized. Misses return null so the caller can decide (warn / fall back).
 */
export function lookupPrice(modelId: string): Price | null {
  if (typeof modelId !== "string" || modelId.length === 0) return null;

  // 1. Exact — fastest path, covers ids already in canonical form.
  const exact = CATALOG.get(modelId);
  if (exact) return exact;

  // 2. Normalized — trimmed + lowercased.
  const norm = normalize(modelId);
  const byNorm = CATALOG.get(norm);
  if (byNorm) return byNorm;

  // 3. Provider-stripped (pi / openclaw / opencode report `provider/model`).
  const bare = stripProviderPrefix(norm);
  if (bare) {
    const byBare = CATALOG.get(bare);
    if (byBare) return byBare;
  }

  return null;
}

/** Price one token bucket. A null bucket rate falls back to the input rate. */
function bucketCost(tokens: number, rate: number | null, inputRate: number): number {
  if (tokens <= 0) return 0;
  const effective = typeof rate === "number" ? rate : inputRate;
  return tokens * effective;
}

/**
 * Σ tokens × per-Mtok price / 1e6 over the four buckets. Returns null when no
 * price is found OR every token count is zero/absent (so dashboards never show
 * a misleading "$0.00 for nothing" row). On a price miss, warns exactly once
 * with the unmatched id so the curated catalog can be extended.
 *
 * Bucket → price mapping:
 *   input_tokens          → input_per_mtok
 *   output_tokens         → output_per_mtok  (null ⇒ input rate)
 *   cache_read_tokens     → cache_read_per_mtok  (null ⇒ input rate)
 *   cache_creation_tokens → cache_write_per_mtok (null ⇒ input rate)
 */
export function computeCostUsd(modelId: string, t: TokenCounts): number | null {
  const input = typeof t.input_tokens === "number" ? t.input_tokens : 0;
  const output = typeof t.output_tokens === "number" ? t.output_tokens : 0;
  const cacheRead = typeof t.cache_read_tokens === "number" ? t.cache_read_tokens : 0;
  const cacheCreate =
    typeof t.cache_creation_tokens === "number" ? t.cache_creation_tokens : 0;

  // All buckets empty ⇒ nothing to price, regardless of model.
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheCreate <= 0) return null;

  const price = lookupPrice(modelId);
  if (!price || typeof price.input_per_mtok !== "number") {
    // Unknown model — emit one line so the id can be added to the catalog.
    console.warn(`[pricing] no curated price for model id: ${modelId}`);
    return null;
  }

  const inputRate = price.input_per_mtok;
  const microDollars =
    bucketCost(input, inputRate, inputRate) +
    bucketCost(output, price.output_per_mtok, inputRate) +
    bucketCost(cacheRead, price.cache_read_per_mtok, inputRate) +
    bucketCost(cacheCreate, price.cache_write_per_mtok, inputRate);

  return microDollars / 1_000_000;
}

/**
 * Prefer a provider-supplied native cost when present, else compute from the
 * catalog. A native cost of exactly 0 is a real value (free tier) and passes
 * through — only null/undefined defers to computeCostUsd.
 */
export function nativeOrComputed(
  modelId: string,
  t: TokenCounts,
  nativeCostUsd?: number | null,
): number | null {
  if (typeof nativeCostUsd === "number") return nativeCostUsd;
  return computeCostUsd(modelId, t);
}
