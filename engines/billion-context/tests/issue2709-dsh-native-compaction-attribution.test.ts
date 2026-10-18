// #2709: a framing-absent host-native compaction landing leaves no checkpoint
// marker for carriesDshLocalCompactionSummary to catch, so the #1001/#2193
// detectors classified it as a generic unannounced rewrite and the banner sent
// users hunting for a phantom second compressor. These tests pin the refusal-ledger
// witness (dshNativeCompactionWitness) and the resulting tiering: an INFERRED
// landing reaches the same "do not hunt for a second plugin" remediation tier as a
// marker-detected one, while a plain unannounced rewrite stays UNCONFIRMED.
import test from "node:test";
import assert from "node:assert/strict";

import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import {
    conflictEventsOf,
    dshNativeCompactionWitness,
    formatConflictSection,
    recordConflict,
} from "../src/conflict-watch.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";

_setStoreForTest(new SessionStore({ enabled: false }));

function makeSession(id: string, metadata: Record<string, unknown> = {}): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        pendingRetrievals: [],
        metadata,
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

test("dshNativeCompactionWitness: dsh-bound + non-zero refusals => count; otherwise undefined (#2709)", () => {
    assert.equal(dshNativeCompactionWitness(makeSession("a", { pluginAgent: "dsh", dshCompactionRefusals: 17 })), 17);
    assert.equal(dshNativeCompactionWitness(makeSession("b", { pluginAgent: "dsh", dshCompactionRefusals: 1 })), 1);
    // zero / missing / non-number refuse the inference (no false positive)
    assert.equal(dshNativeCompactionWitness(makeSession("c", { pluginAgent: "dsh", dshCompactionRefusals: 0 })), undefined);
    assert.equal(dshNativeCompactionWitness(makeSession("d", { pluginAgent: "dsh" })), undefined);
    assert.equal(dshNativeCompactionWitness(makeSession("e", { pluginAgent: "dsh", dshCompactionRefusals: "5" })), undefined);
    // non-dsh clients never attribute to their own native compaction this way
    assert.equal(dshNativeCompactionWitness(makeSession("f", { pluginAgent: "pi", dshCompactionRefusals: 5 })), undefined);
    assert.equal(dshNativeCompactionWitness(makeSession("g", { dshCompactionRefusals: 5 })), undefined);
});

test("inferred landing reaches the 'no second compressor' remediation, distinct from a rebuild promise (#2709)", () => {
    const s = makeSession("s");
    recordConflict(s, "native-compaction-inferred", "framing absent on replay; bili refused 17 client-native compaction call(s) this session (#1729/#2028) — attributed to client-native compaction [inferred] (140/320 incoming carry pre-turn refs of 771 known, #2709)");
    const text = formatConflictSection(conflictEventsOf(s)).join("\n");
    // header flips to the native-present framing (not the generic "diagnostic evidence")
    assert.match(text, /Two compressors on one conversation/);
    // inferred-specific advice: precise about NOT being able to rebuild the fold base
    assert.match(text, /did NOT see the checkpoint marker/);
    // and it must NOT promise the rebuild that only a marker-detected landing allows
    assert.doesNotMatch(text, /rebuilds the fold state onto them where possible/);
    // and it must NOT send the user hunting for a second plugin
    assert.match(text, /do not go hunting for a second plugin/);
});

test("marker-detected (recovered) landing gets the calm 'already rebased' framing, not an alarm (#2709/#2912)", () => {
    const s = makeSession("s");
    recordConflict(s, "native-compaction", "dsh native compaction: 40/120 covered id(s) replaced by the compacted history; ACP state rebased (#2432)");
    const text = formatConflictSection(conflictEventsOf(s)).join("\n");
    // #2912: a marker-detected landing was already rebased onto (#2372/#2432) — say so plainly,
    // and do NOT re-frame it as live double-compression or promise a rebuild.
    assert.match(text, /ALREADY rebased onto/);
    assert.doesNotMatch(text, /Two compressors on one conversation/);
    assert.doesNotMatch(text, /rebuilds the fold state onto them where possible/);
    assert.doesNotMatch(text, /did NOT see the checkpoint marker/);
});

test("plain unannounced rewrite stays UNCONFIRMED — false-positive guard (#2709)", () => {
    const s = makeSession("s");
    recordConflict(s, "unannounced-rewrite", "140/320 incoming message(s) carry pre-turn refs of 771 known");
    const text = formatConflictSection(conflictEventsOf(s)).join("\n");
    assert.match(text, /UNCONFIRMED signal/);
    assert.doesNotMatch(text, /Two compressors on one conversation/);
    assert.doesNotMatch(text, /did NOT see the checkpoint marker/);
});

test("inferred alongside a recovered landing: the higher-risk inferred framing wins (#2709/#2912)", () => {
    const s = makeSession("s");
    recordConflict(s, "native-compaction-inferred", "framing absent on replay; bili refused 3 client-native compaction call(s) this session [inferred] (#2709)");
    recordConflict(s, "native-compaction", "dsh native compaction: 40/120 covered id(s) replaced; ACP state rebased (#2432)");
    const text = formatConflictSection(conflictEventsOf(s)).join("\n");
    // #2912: the recovered landing alone would stand down, but the co-present INFERRED landing
    // could not be rebased onto — its higher-risk framing must win over the calm handled text.
    assert.match(text, /did NOT see the checkpoint marker/);
    assert.doesNotMatch(text, /rebuilds the fold state onto them where possible/);
    assert.doesNotMatch(text, /ALREADY rebased onto/);
});
