import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { _resetForTest, _setForTest, peekRegistryOutputLimit, bundledSnapshotOutputLimit } from "../src/registry.ts";

process.env.NODE_ENV = "test";

afterEach(() => {
    _resetForTest();
});

// #853: output-ceiling lookup mirrors the context-window lookup — exact key,
// bare-root strip for relay ids, host-pinned provider namespace, cross-provider
// MAX on conflicts (understating a ceiling re-introduces the #853 starvation).
test("#853 peekRegistryOutputLimit: exact, strip, host-aware, unknown", () => {
    _setForTest({
        "deepseek/deepseek-v3": { limit: { context: 131072, output: 8192 } },
        "other/deepseek-v3": { limit: { context: 131072, output: 4096 } },
        "alibaba/qwen3.6-27b-thinking": { limit: { context: 262144, output: 16384 } },
    });

    assert.equal(peekRegistryOutputLimit("deepseek/deepseek-v3"), 8192, "exact namespaced key");
    assert.equal(peekRegistryOutputLimit("deepseek-v3"), 8192, "bare name cross-provider scan takes the max");
    assert.equal(peekRegistryOutputLimit("qwen/qwen3.6-27b-thinking"), 16384, "relay prefix strips and variant suffix (-thinking) resolves to the base entry");
    assert.equal(peekRegistryOutputLimit("deepseek-v3", "api.deepseek.com"), 8192, "known-provider host pins the namespace");
    assert.equal(peekRegistryOutputLimit("no-such-model"), undefined, "unknown model has no known ceiling");
});

// The reported model (deepseek-v4-flash, ceiling 384k) must resolve to its
// real ceiling — present, not missing — so min(32768, 384000) keeps the full
// default; and a genuinely small model resolves to its cap so the preflight
// clamp engages. Both from the bundled offline floor.
test("#853 bundledSnapshotOutputLimit: offline floor resolves real ceilings", () => {
    assert.equal(bundledSnapshotOutputLimit("deepseek-v4-flash", "api.deepseek.com"), 384000);
    const capped = bundledSnapshotOutputLimit("deepseek-v3", "api.deepseek.com");
    assert.ok(typeof capped === "number" && capped > 0 && capped < 32768, `expected a sub-32k ceiling, got ${capped}`);
    assert.equal(bundledSnapshotOutputLimit("no-such-model-anywhere"), undefined);
});
