// #3354: stand dsh's native basic compaction down at LOAD TIME — vendored from
// deshark42/dsh-compaction-basic-disable v0.1.1 (MIT © 2026 deshark42,
// https://github.com/deshark42/dsh-compaction-basic-disable), ported into
// bili's own bundle layer at the author's suggestion (their repo issue #1).
// The overlay marks the preset rows disabled instead of copying or overwriting
// the official preset configs, so upstream preset updates keep working without
// re-copying a frozen snapshot — the #2474 full-snapshot recipe stays as the
// fallback for dsh builds whose internal 'internal/config' hook moved.
//
// Why it exists: when bili carries a dsh conversation it owns compression
// (#1729); a dsh compaction checkpoint landing outside bili's knowledge
// durably shadows the raw history and destroys the compression substrate.
// Non-web profiles already stand down the host-plane row via the bundle patch
// (auto:false); web profiles run their instance INSIDE an agent preset whose
// nested rows no patch layer can address by id (#1772/#2360) — this module is
// what reaches them.

/** The two dsh packages whose backends must not instantiate while bili owns the lane. */
const DSH_COMPACTION_BASIC_PACKAGE = "@deepseek-ai/dsh-compaction-basic";
const DSH_COMMAND_COMPACT_PACKAGE = "@deepseek-ai/dsh-command-compact";
/** The agent-preset entry whose resolved config carries the plugin rows. */
const DSH_AGENT_PRESET_PACKAGE = "@deepseek-ai/dsh-agent-preset";
/** Gate service name referenced by the preset `inject:` entries in
 *  dsh.bundle.patch.yml and the launcher overlay patch. A preset cannot
 *  register until this service is provided, so the middleware below is
 *  guaranteed registered before any protected preset resolves its config even
 *  when sibling imports finish out of order; if this module fails to load the
 *  presets stay pending (fail-safe: no unprotected start). Coexistence with
 *  the upstream plugin is safe: its service name differs and both overlays are
 *  idempotent (disabled:true twice = disabled:true). */
export const BILI_COMPACTION_DISABLE_SERVICE = "biliBasicCompactionPolicy";
/** The four Web agent presets the overlay must reach (dsh-web-app roster;
 *  preset-minimal ships no compaction group today — the row is a no-op there
 *  and future-proofs it if one lands). */
const DSH_WEB_PRESET_IDS = ["preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"] as const;

/** The bundle-patch rows gating each Web preset on the overlay service — the
 *  single source of truth shared by the launcher overlay string and pinned
 *  against dsh.bundle.patch.yml by tests (the two layers must stay in sync,
 *  cf. #2605). Entry inject lists are REPLACED by patches, not concatenated —
 *  if a future dsh ships its own inject list on these entries, merge manually
 *  here AND in both patch layers. */
export function compactionDisablePatchRows(): string {
    return DSH_WEB_PRESET_IDS.map((id) => `- id: ${id}\n  inject: [${BILI_COMPACTION_DISABLE_SERVICE}]\n`).join("");
}

type PresetRow = { name?: unknown; group?: unknown; config?: unknown };

/** Mark every compaction row of a preset plugins tree disabled. Pure: returns
 *  detached copies and never mutates the input rows (the resolved config may
 *  be shared with other consumers). */
export function disableBasicCompaction(rows: readonly unknown[]): unknown[] {
    return rows.map((row) => {
        if (row === null || typeof row !== "object") return row;
        const r = row as PresetRow & Record<string, unknown>;
        if (r.name === DSH_COMPACTION_BASIC_PACKAGE || r.name === DSH_COMMAND_COMPACT_PACKAGE) {
            return { ...r, disabled: true };
        }
        if (r.group && Array.isArray(r.config)) {
            return { ...r, config: disableBasicCompaction(r.config) };
        }
        return row;
    });
}

type CompactionDisableHost = {
    on?: (event: string, listener: (raw: unknown, next: () => unknown) => unknown, options?: { global?: boolean }) => void;
    reflect?: { provide?: (name: string, value: unknown) => void } | undefined;
};
type MiddlewareSelf = { entry?: { options?: { name?: unknown } } | undefined };

/** Register the load-time overlay + publish the gate. Must run during
 *  apply() — the provide happens AFTER the middleware registers so the inject
 *  gate can never be satisfied before the transform is live. Degradation is
 *  per-layer and fail-safe: no `on` → the host predates the internal/config
 *  hook, the wire-level refusal guard (#1729) stays the backstop; no
 *  `reflect.provide` → the presets simply never see the gate and boot as they
 *  did pre-#3354. */
export function registerCompactionDisable(ctx: CompactionDisableHost): void {
    if (typeof ctx.on === "function") {
        // Preset entries must carry the gate: sibling imports may finish out of order.
        ctx.on("internal/config", function (this: MiddlewareSelf, _raw: unknown, next: () => unknown): unknown {
            const resolved = next();
            if (this?.entry?.options?.name !== DSH_AGENT_PRESET_PACKAGE) return resolved;
            const config = (resolved ?? {}) as { plugins?: unknown };
            if (!Array.isArray(config.plugins)) return resolved;
            return { ...config, plugins: disableBasicCompaction(config.plugins) };
        }, { global: true });
    }
    // Publish only after the middleware is registered; the host owns both lifetimes.
    ctx.reflect?.provide?.(BILI_COMPACTION_DISABLE_SERVICE, Object.freeze({ owner: "billion-context", issue: "#3354" }));
}
