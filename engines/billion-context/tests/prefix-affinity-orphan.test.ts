// #2791: the silent half of an identity-loss takeover. When a host loses its
// client identity mid-conversation (the observed case: dsh's
// anthropic-messages lane bypasses the native-intercept fetch patch, so its
// requests arrive with ZERO bili headers), the anonymous resolver mints a
// fresh pfa-* session and the identified conversation's fold ledger is
// orphaned with NO observable signal — the next request pays a full silent
// re-fold (#2733/#2741 observed a 263%-of-window replay).
//
// The root cause (host fetch-capture timing) is out of bili's reach, but the
// SILENCE is a bili-side signal-chain break and fully provable: the resolver
// already sees (a) an identified chain whose depth the incoming anonymous
// history reaches, and (b) the #2601 normalized tail fingerprint, which
// survives cross-wire re-serialization of the same turn. This suite pins the
// detection contract:
//   - resolver level: a cross-shaped anonymous replay (every per-item hash
//     diverges, so the exact/simhash/fork ladders are structurally blind)
//     flags the identified chain in `orphanSuspect` WITHOUT adopting it
//     (#1486 stands — resolution is unchanged, still a fresh pfa-* mint);
//   - negatives: different content, an anonymous (non-identified) chain, or a
//     replay far deeper than the append bound do NOT flag;
//   - server level: the mint consumes the flag — a warn log line plus an
//     `identity-orphan` conflict event on the ORPHANED session naming the
//     fresh fork id, while the orphaned session's compression state is left
//     untouched (the detection is diagnostics-only, never a repair).
//
// Harness: unit tests drive the resolver directly (same idiom as
// issue2601-model-drift-absorption); the integration test runs one chat-lane
// startServer rig — the detection logic is protocol-agnostic (it consumes the
// normalized message projection), the wire shape of the replay is simulated
// by re-serializing content strings into content-arrays, which is exactly the
// openai-vs-anthropic shape churn that blinded the byte ladders in #2791.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

// Hermetic state dirs BEFORE importing the server modules (the prefix
// affinity snapshot persists across runs otherwise — #2719 test idiom).
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-2791-orphan-"));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const { prefixAffinity } = await import("../src/prefix-affinity.ts");

test.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

type Msg = { role: string; content: string };

const msg = (i: number, tag: string): Msg => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `${tag}-${i + 1}-` + "y".repeat(120),
});

/** The #2791 shape churn: string content -> content:[{type:"text"}] — the
 *  same turn on the anthropic lane. Every byte-ladder hash diverges; the
 *  normalized projection (content leaves ≥ MIN_NORM_LEAF_LEN + role marker)
 *  does not. */
const crossShaped = (chain: Msg[]): unknown[] =>
    chain.map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] }));

/** Mirror of the server's identified-note path (handle.ts): chainFingerprint
 *  + note(..., identified=true, normTailHash). */
function seedIdentified(conv: string, chain: Msg[]): void {
    prefixAffinity.forget(conv);
    const fp = prefixAffinity.chainFingerprint(chain);
    assert.ok(fp, "chain fingerprint exists");
    assert.ok(fp.normTailHash, "normalized tail fingerprint exists");
    prefixAffinity.note(conv, fp.depth, fp.tailHash, fp.itemHashes, true, undefined, undefined, fp.normTailHash);
}

test("resolver: a cross-shaped anonymous replay flags the identified chain without adopting it (#2791)", () => {
    const conv = "orphan-unit-1";
    const chain = Array.from({ length: 6 }, (_, i) => msg(i, "conv1"));
    seedIdentified(conv, chain);

    // The anonymous replay carries the same conversation re-serialized, plus
    // two appended turns (the host's new question) — the positional
    // fingerprint must look at the position where the chain ended.
    const replay = [...crossShaped(chain), msg(6, "conv1"), msg(7, "conv1")];
    const out = prefixAffinity.resolve(replay)!;
    assert.ok(out, "resolver returns a mint");
    assert.equal(out.via, "new", "no adoption: #1486 stands");
    assert.ok(out.sessionId.startsWith("pfa-"), `fresh anonymous mint, got ${out.sessionId}`);
    assert.notEqual(out.sessionId, conv);
    assert.deepEqual(out.orphanSuspect, [conv], "the orphaned identified chain is named");
});

test("resolver: different content under the same shape churn does not flag", () => {
    const conv = "orphan-unit-2";
    seedIdentified(conv, Array.from({ length: 6 }, (_, i) => msg(i, "conv2")));
    const foreign = crossShaped(Array.from({ length: 6 }, (_, i) => msg(i, "other")));
    const out = prefixAffinity.resolve([...foreign, msg(6, "other"), msg(7, "other")])!;
    assert.equal(out.via, "new");
    assert.equal(out.orphanSuspect, undefined, "foreign content is not an orphan suspect");
});

test("resolver: an anonymous chain forking again is not an orphan event", () => {
    const conv = "orphan-unit-3";
    const chain = Array.from({ length: 6 }, (_, i) => msg(i, "conv3"));
    prefixAffinity.forget(conv);
    const fp = prefixAffinity.chainFingerprint(chain);
    assert.ok(fp);
    prefixAffinity.note(conv, fp.depth, fp.tailHash, fp.itemHashes, false, undefined, undefined, fp.normTailHash);
    const out = prefixAffinity.resolve([...crossShaped(chain), msg(6, "conv3")])!;
    // #2791 wire-neutral hashing: a cross-shaped replay of an ANONYMOUS chain
    //  no longer forks at all — it re-attaches by neutral prefix (that is the
    //  fix). No mint => no orphan scan; identified chains are the only orphan
    //  candidates regardless.
    assert.equal(out.via, "prefix");
    assert.equal(out.sessionId, conv, "cross-shaped anonymous replay re-attaches to its chain");
    assert.equal(out.orphanSuspect, undefined, "only IDENTIFIED chains can be orphaned");
});

test("resolver: a replay far past the append bound does not flag", () => {
    const conv = "orphan-unit-4";
    const chain = Array.from({ length: 4 }, (_, i) => msg(i, "conv4"));
    seedIdentified(conv, chain);
    const deep = [...crossShaped(chain), ...Array.from({ length: 80 }, (_, i) => msg(4 + i, "conv4"))];
    const out = prefixAffinity.resolve(deep)!;
    assert.equal(out.via, "new");
    assert.equal(out.orphanSuspect, undefined, "out of the append window the tail fingerprint is not evidence");
});

test("server: an identity-loss takeover warns and records identity-orphan on the orphaned session (#2791)", { timeout: 120_000 }, async () => {
    const { startServer } = await import("../src/server.ts");
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
    const { getSession } = await import("../src/session.ts");
    const { conflictEventsOf } = await import("../src/conflict-watch.ts");
    const { _resetPluginStateForTest } = await import("../src/plugin.ts");
    const { defaultConfig } = await import("acp-kernel");

    const CONV = "orphan-2791-conv";
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            bodies.push(body);
            const idx = bodies.length;
            const prompt = Math.max(1, Math.ceil(body.length / 4));
            const usage = { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5 };
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const line = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
            line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: `Reply ${idx}: acknowledged. ` + "z".repeat(64) } }] });
            line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    prefixAffinity.forget(CONV);
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-orphan": { context: 200_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: false, injectNudge: false },
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as unknown as import("../src/config.ts").ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    try {
        // Phase 1: the identified (plugin) era — the conversation lives under
        // x-bili-plugin headers, exactly like the pre-switch dsh openai lane.
        const conv: Msg[] = Array.from({ length: 6 }, (_, i) => msg(i, "live"));
        const pluginHeaders = { "x-bili-plugin": "pi-plugin/0.0.1", "x-bili-plugin-conversation": CONV };
        for (let t = 1; t <= 3; t++) {
            conv.push({ role: "user", content: `live-user-${t}-` + "y".repeat(120) });
            const resp = await fetch(base, { method: "POST", headers: { "content-type": "application/json", ...pluginHeaders }, body: JSON.stringify({ model: "gpt-orphan", stream: true, messages: [...conv] }) });
            assert.equal(resp.status, 200, `identified turn ${t}`);
            await resp.text();
            conv.push({ role: "assistant", content: `live-assistant-${t}-` + "y".repeat(120) });
        }
        const identified = getSession(CONV);
        assert.ok(identified, "identified session exists");
        const identifiedKeySnapshot = JSON.stringify(identified.state.messageRefs.byRaw);
        const blocksSnapshot = identified.state.blocks.map((b) => b.blockId);

        // Phase 2: the host loses its identity — same conversation replayed
        // headerless and re-serialized (the anthropic lane's content-arrays).
        const anon = [...crossShaped(conv), { role: "user", content: `anon-question-1-` + "y".repeat(120) }];
        const resp = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-orphan", stream: true, messages: anon }) });
        assert.equal(resp.status, 200, "the anonymous replay is still served");
        await resp.text();

        // The takeover must not be silent: the orphaned session carries an
        // identity-orphan conflict event naming the fresh pfa-* fork.
        const events = conflictEventsOf(getSession(CONV)!).filter((e) => e.kind === "identity-orphan");
        assert.equal(events.length, 1, `exactly one identity-orphan event, got ${JSON.stringify(conflictEventsOf(getSession(CONV)!))}`);
        assert.match(events[0]!.detail, /pfa-[0-9a-f]{16}/, "the event names the fresh anonymous fork");
        assert.match(events[0]!.detail, /#2791/);

        // Diagnostics-only: resolution and the orphaned session's compression
        // state are untouched (#1486 stands, no repair side effects).
        const after = getSession(CONV)!;
        assert.equal(JSON.stringify(after.state.messageRefs.byRaw), identifiedKeySnapshot, "no ref churn on the orphaned session");
        assert.deepEqual(after.state.blocks.map((b) => b.blockId), blocksSnapshot, "no block churn on the orphaned session");
        const mints = prefixAffinity.trackedSessionIds().filter((id) => id.startsWith("pfa-"));
        assert.ok(mints.length >= 1, "a fresh anonymous session was minted for the replay");
    } finally {
        prefixAffinity.forget(CONV);
        proxy.close();
        upstream.close();
    }
});
