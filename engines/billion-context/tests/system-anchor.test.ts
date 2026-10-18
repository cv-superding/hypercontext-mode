// #1085: sticky head-system anchor unit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileSystemAnchor, diffLines, ANCHOR_MAX_NOTES, UPDATE_MARKER } from "../src/system-anchor.ts";
import type { Session } from "../src/session.ts";

const log = () => {};

function makeSession(): Session {
    return { metadata: {} } as unknown as Session;
}

function head(lines: string[]): string {
    return lines.join("\n");
}

test("first non-empty head is captured as the anchor", () => {
    const s = makeSession();
    const out = reconcileSystemAnchor(s, "anthropic", "HEAD-V1", "t1", log);
    assert.equal(out.outbound, "HEAD-V1");
    assert.deepEqual(out.notes, []);
    assert.equal(out.changed, false);
});

test("empty head is never anchored; a later non-empty head captures", () => {
    const s = makeSession();
    let out = reconcileSystemAnchor(s, "anthropic", "", "t1", log);
    assert.equal(out.outbound, "");
    assert.deepEqual(out.notes, []);
    out = reconcileSystemAnchor(s, "anthropic", "HEAD-V1", "t2", log);
    assert.equal(out.outbound, "HEAD-V1");
});

test("diffLines renders context/removed/added hunks", () => {
    const oldT = head(["l1", "l2", "l3", "l4", "l5", "l6"]);
    const newT = head(["l1", "l2", "L3-NEW", "l4", "l5", "l6"]);
    const hunks = diffLines(oldT, newT)!;
    assert.equal(hunks.length, 1);
    assert.ok(hunks[0].includes("-l3"));
    assert.ok(hunks[0].includes("+L3-NEW"));
    assert.ok(hunks[0].includes("  l2"));
    assert.ok(hunks[0].includes("  l4"));
});

test("diffLines rejects non-localized and oversized changes", () => {
    assert.equal(diffLines("a\nb\nc", "x\ny"), null);
    // One edit in a 401-line head still exceeds DIFF_MAX_LINES → not annotated.
    const big = Array.from({ length: 401 }, (_, i) => `line-${i}`).join("\n");
    assert.equal(diffLines(big, big.replace("line-5", "LINE-FIVE")), null);
});

test("unchanged head re-injects existing notes without duplication", () => {
    const s = makeSession();
    const A = head(["preamble", "rule-one", "extra", "postamble"]);
    const B = head(["preamble", "rule-TWO", "extra", "postamble"]);
    reconcileSystemAnchor(s, "openai", A, "t1", log);
    const changed = reconcileSystemAnchor(s, "openai", B, "t2", log);
    assert.equal(changed.changed, true);
    assert.equal(changed.notes.length, 1);
    assert.ok(changed.notes[0].startsWith(UPDATE_MARKER));
    assert.ok(changed.notes[0].includes("-rule-one"));
    assert.ok(changed.notes[0].includes("+rule-TWO"));
    const again = reconcileSystemAnchor(s, "openai", B, "t3", log);
    assert.equal(again.changed, false);
    assert.equal(again.outbound, A);
    assert.equal(again.notes.length, 1);
});

test("change forwards the OLD anchor byte-stable and appends a compact diff note", () => {
    const s = makeSession();
    const V1 = head(["h1", "h2", "h3", "h4"]);
    const V2 = head(["h1", "H2", "h3", "h4"]);
    reconcileSystemAnchor(s, "google", V1, "t1", log);
    const out = reconcileSystemAnchor(s, "google", V2, "t2", log);
    assert.equal(out.outbound, V1);
    assert.equal(out.notes.length, 1);
    // The note is a diff, not a resend of the whole new head: only the
    // changed line carries +/- prefixes, unchanged lines never do.
    assert.ok(out.notes[0].includes("-h2"));
    assert.ok(out.notes[0].includes("+H2"));
    assert.ok(!out.notes[0].includes("-h3") && !out.notes[0].includes("+h3"));
    assert.ok(!out.notes[0].includes("-h4") && !out.notes[0].includes("+h4"));
});

test("notes compose sequentially onto the version in effect so far", () => {
    const s = makeSession();
    const V1 = head(["h1", "h2", "h3", "h4"]);
    const V2 = head(["h1", "H2", "h3", "h4"]);
    const V3 = head(["h1", "H2", "h3", "H4"]);
    reconcileSystemAnchor(s, "google", V1, "t1", log);
    const o2 = reconcileSystemAnchor(s, "google", V2, "t2", log);
    assert.equal(o2.outbound, V1);
    assert.equal(o2.notes.length, 1);
    assert.ok(o2.notes[0].includes("-h2") && o2.notes[0].includes("+H2"));
    assert.ok(!o2.notes[0].includes("-h4"));
    const o3 = reconcileSystemAnchor(s, "google", V3, "t3", log);
    assert.equal(o3.outbound, V1);
    assert.equal(o3.notes.length, 2);
    // The second note diffs V2→V3, not V1→V3 — h2 was already reported once.
    assert.ok(o3.notes[1].includes("-h4") && o3.notes[1].includes("+H4"));
    assert.ok(!o3.notes[1].includes("-h2"));
    assert.ok(!o3.notes[1].includes("+H2"));
});

test("non-localized head change adopts the new head outright (deliberate miss)", () => {
    const s = makeSession();
    const V1 = head(["alpha", "beta", "gamma", "delta"]);
    const V2 = head(["completely", "different", "content", "entirely"]);
    reconcileSystemAnchor(s, "anthropic", V1, "t1", log);
    const out = reconcileSystemAnchor(s, "anthropic", V2, "t2", log);
    assert.equal(out.changed, true);
    assert.equal(out.outbound, V2);
    assert.deepEqual(out.notes, []);
    const again = reconcileSystemAnchor(s, "anthropic", V2, "t3", log);
    assert.equal(again.changed, false);
    assert.equal(again.outbound, V2);
});

test("removed head appends a removal note but keeps the anchor flowing", () => {
    const s = makeSession();
    reconcileSystemAnchor(s, "responses", "some-head", "t1", log);
    const out = reconcileSystemAnchor(s, "responses", "", "t2", log);
    assert.equal(out.outbound, "some-head");
    assert.equal(out.notes.length, 1);
    assert.equal(out.notes[0], "[System context update] Previously loaded ambient instructions no longer apply.");
});

test("churn guard replaces the anchor outright past the note cap", () => {
    const s = makeSession();
    const base = Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n");
    reconcileSystemAnchor(s, "anthropic", base, "t0", log);
    let out: ReturnType<typeof reconcileSystemAnchor>;
    for (let i = 1; i <= ANCHOR_MAX_NOTES; i++) {
        const next = base.split("\n");
        next[i] = `CHANGED-${i}`;
        out = reconcileSystemAnchor(s, "anthropic", next.join("\n"), `t${i}`, log);
    }
    assert.equal(out!.notes.length, ANCHOR_MAX_NOTES);
    assert.equal(out!.outbound, base);
    const finalLines = base.split("\n");
    finalLines[ANCHOR_MAX_NOTES] = "CHANGED-final";
    const over = reconcileSystemAnchor(s, "anthropic", finalLines.join("\n"), "tf", log);
    assert.equal(over.changed, true);
    assert.equal(over.outbound, finalLines.join("\n"));
    assert.deepEqual(over.notes, []);
    // The replacement is now itself the sticky anchor.
    const steady = reconcileSystemAnchor(s, "anthropic", finalLines.join("\n"), "tg", log);
    assert.equal(steady.changed, false);
    assert.equal(steady.outbound, finalLines.join("\n"));
});

test("state survives a JSON persistence round-trip", () => {
    const s = makeSession();
    const A = head(["k1", "k2", "k3", "k4"]);
    const B = head(["k1", "K2", "k3", "k4"]);
    reconcileSystemAnchor(s, "openai", A, "t1", log);
    reconcileSystemAnchor(s, "openai", B, "t2", log);
    const restored = JSON.parse(JSON.stringify(s.metadata)) as Record<string, unknown>;
    const s2 = { metadata: restored } as unknown as Session;
    const out = reconcileSystemAnchor(s2, "openai", B, "t3", log);
    assert.equal(out.outbound, A);
    assert.equal(out.notes.length, 1);
});

test("surfaces are independent per session", () => {
    const s = makeSession();
    reconcileSystemAnchor(s, "anthropic", "A-head", "t1", log);
    const out = reconcileSystemAnchor(s, "openai", "A-head", "t1", log);
    assert.equal(out.changed, false);
    assert.equal(out.outbound, "A-head");
    assert.equal(out.notes.length, 0);
});

test("interop: a third-party client doing its own in-history updates gets zero bili injection", () => {
    // The client keeps its system prompt byte-stable and records instruction
    // changes as ordinary user messages inside the history (opencode-style).
    // The proxy only sees the constant head — it must stay completely silent.
    const s = makeSession();
    const system = "STABLE-AMBIENT-INSTRUCTIONS";
    const turns = [
        { user: "hello" },
        { user: "These instructions replace all previously loaded ambient instructions.\n\nNEW-RULES" },
        { user: "and more work" },
    ];
    for (let i = 0; i < turns.length; i++) {
        const out = reconcileSystemAnchor(s, "responses", system, `t${i}`, log);
        assert.equal(out.outbound, system);
        assert.deepEqual(out.notes, []);
        assert.equal(out.changed, false);
    }
});
