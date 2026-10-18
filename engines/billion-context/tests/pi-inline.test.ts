// #3278: pi inline lane — the no-server mode. Two layers under test:
//  1. the fetch-chain transport link (pi-inline.ts): pseudo-origin traffic is
//     served in-process, foreign traffic passes through, engine failure
//     degrades model traffic to direct upstream while management calls fail loud;
//  2. the in-process engine itself (inline-engine.ts): the real pipeline boots
//     without any proxy process, serves model + admin traffic against a local
//     mock upstream, makes exactly ONE upstream round trip per request (loop
//     safety), and tracks the session in-process.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Hermetic storage BEFORE anything store-touching loads (same pattern as
// opencode-native.test.ts): the real engine boot writes sessions/logs here.
// All THREE XDG homes: sessions live under XDG_DATA_HOME, the conversation
// routing table under XDG_STATE_HOME — a missing one leaks debounced writes
// into the real store after env restore.
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pi-inline-state-"));
const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pi-inline-data-"));
const CONFIG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pi-inline-config-"));
const PREV_STATE = process.env.XDG_STATE_HOME;
const PREV_DATA = process.env.XDG_DATA_HOME;
const PREV_CONFIG = process.env.XDG_CONFIG_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
process.env.XDG_DATA_HOME = DATA_ROOT;
process.env.XDG_CONFIG_HOME = CONFIG_ROOT;
after(async () => {
    // Force the debounced writers out while the hermetic dirs are still bound.
    try {
        const { flushConversations } = await import("../src/plugin.ts");
        const { flushAllSessions } = await import("../src/session.ts");
        flushConversations();
        await flushAllSessions();
    } catch { /* engine never booted in this run */ }
    if (PREV_STATE === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_STATE;
    if (PREV_DATA === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = PREV_DATA;
    if (PREV_CONFIG === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = PREV_CONFIG;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
    fs.rmSync(DATA_ROOT, { recursive: true, force: true });
    fs.rmSync(CONFIG_ROOT, { recursive: true, force: true });
});

const hits: string[] = [];
let slowCompleted = false;
const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        hits.push(`${req.method} ${req.url}`);
        if (req.url === "/v1/messages") {
            const reply = () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_1",
                    type: "message",
                    role: "assistant",
                    model: "test-model",
                    content: [{ type: "text", text: "hello-inline" }],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: { input_tokens: 10, output_tokens: 5 },
                }));
            };
            if (body.includes("slow-please")) {
                // Cancel-parity probe (#3278 review): a deliberately slow
                // completion on the real model lane — if the in-process round
                // trip is truly aborted, this never fires.
                setTimeout(() => {
                    if (res.destroyed) return;
                    slowCompleted = true;
                    reply();
                }, 2500);
            } else {
                reply();
            }
        } else {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "not found" }));
        }
    });
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
after(() => {
    upstream.closeAllConnections();
    upstream.close();
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<never>((_, rej) => {
            const t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms);
            t.unref?.();
        }),
    ]);
}

async function freshChain() {
    const fc = await import("../src/agent/fetch-chain/index.ts");
    const piInline = await import("../src/agent/pi-inline.ts");
    fc.resetFetchChainForTest();
    piInline._resetInlineTransportForTest();
    piInline.installInlineTransport();
    return piInline;
}

test("#3278 transport: pseudo-origin URLs are served in-process, foreign URLs pass through", async () => {
    const ie = await import("../src/inline-engine.ts");
    const calls: string[] = [];
    ie._setEngineFactoryForTest(async () => ({
        origin: ie.INLINE_ORIGIN,
        dispatch: async (input: string | URL | Request): Promise<Response> => {
            calls.push(String(input));
            return new Response("inline-ok");
        },
    }));
    try {
        await freshChain();
        const r = await withTimeout(fetch(`${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`), 10_000, "inline dispatch");
        assert.equal(r.status, 200);
        assert.equal(await r.text(), "inline-ok");
        assert.deepEqual(calls, [`${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`]);
        // non-pseudo-origin traffic must reach its real destination untouched
        const before = hits.length;
        const p = await withTimeout(fetch(`${upstreamOrigin}/v1/messages`, { method: "POST", body: "{}" }), 10_000, "passthrough");
        assert.equal(p.status, 200);
        assert.deepEqual(hits.slice(before), ["POST /v1/messages"]);
    } finally {
        const piInline = await import("../src/agent/pi-inline.ts");
        const fc = await import("../src/agent/fetch-chain/index.ts");
        piInline._resetInlineTransportForTest();
        fc.resetFetchChainForTest();
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});

test("#3278 transport: engine failure degrades model traffic direct, management fails loud", async () => {
    const ie = await import("../src/inline-engine.ts");
    ie._setEngineFactoryForTest(async () => {
        throw new Error("boom");
    });
    try {
        await freshChain();
        const before = hits.length;
        // prefix stripped → the request lands on the REAL upstream, uncompressed
        const r = await withTimeout(fetch(`${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`, { method: "POST", body: "{}" }), 10_000, "degrade");
        assert.equal(r.status, 200);
        assert.match(await r.text(), /hello-inline/);
        assert.deepEqual(hits.slice(before), ["POST /v1/messages"]);
        // management traffic has no direct meaning — it must reject, not wander
        await assert.rejects(withTimeout(fetch(`${ie.INLINE_ORIGIN}/__bili/health`), 10_000, "mgmt reject"));
    } finally {
        const piInline = await import("../src/agent/pi-inline.ts");
        const fc = await import("../src/agent/fetch-chain/index.ts");
        piInline._resetInlineTransportForTest();
        fc.resetFetchChainForTest();
        ie._setEngineFactoryForTest(undefined);
        ie._resetInlineEngineForTest();
    }
});

test("#3278 engine: real pipeline runs in-process — one upstream round trip, session tracked, admin reachable", { timeout: 90_000 }, async () => {
    const ie = await import("../src/inline-engine.ts");
    const { listSessions } = await import("../src/session.ts");
    const before = hits.length;
    const engine = await withTimeout(ie.getInlineEngine(), 60_000, "engine boot");
    assert.equal(engine.origin, ie.INLINE_ORIGIN);
    // max_tokens > 200 keeps this on the main model lane (processTurn), not
    // the side-request passthrough lane.
    const body = JSON.stringify({ model: "test-model", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] });
    const r = await withTimeout(
        engine.dispatch(
            `${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`,
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-bili-plugin": "pi",
                    "x-bili-plugin-conversation": "inline-e2e-session-1",
                },
                body,
            },
            globalThis.fetch,
        ),
        30_000,
        "model dispatch",
    );
    assert.equal(r.status, 200);
    const j = (await r.json()) as { content: { text: string }[] };
    assert.equal(j.content[0].text, "hello-inline");
    // loop safety: exactly ONE upstream round trip — a re-entrant rewrite into
    // the patched fetch would double the hit count or hang until timeout
    assert.deepEqual(hits.slice(before), ["POST /v1/messages"]);
    // compression bookkeeping ran in this process
    assert.ok(listSessions().length >= 1, `expected an in-process session, got ${listSessions().length}`);
    // the loopback-gated admin surface answers through the pseudo-origin
    const h = await withTimeout(engine.dispatch(`${ie.INLINE_ORIGIN}/__bili/health`, {}, globalThis.fetch), 10_000, "health");
    assert.equal(h.status, 200);
});

test("#3278 engine: caller abort cancels the in-process round trip (spawn-mode parity)", { timeout: 60_000 }, async () => {
    const ie = await import("../src/inline-engine.ts");
    const engine = await withTimeout(ie.getInlineEngine(), 60_000, "engine boot");
    const ac = new AbortController();
    const settled = engine.dispatch(
        // real model lane (max_tokens > 200): the slow-please marker makes the
        // mock hold the response 2.5s so the abort lands mid-round-trip
        `${ie.INLINE_ORIGIN}/bili/${upstreamOrigin}/v1/messages`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-bili-plugin": "pi",
                "x-bili-plugin-conversation": "inline-abort-session",
            },
            body: JSON.stringify({ model: "test-model", max_tokens: 1024, messages: [{ role: "user", content: "hi slow-please" }] }),
            signal: ac.signal,
        },
        globalThis.fetch,
    ).then(
        (r) => { throw new Error(`expected abort rejection, got HTTP ${r.status}`); },
        (e: unknown) => e,
    );
    setTimeout(() => ac.abort(), 150);
    const err = await withTimeout(settled, 10_000, "abort propagation") as Error;
    assert.equal(err.name, "AbortError");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(slowCompleted, false, "upstream round trip must not complete after the caller aborted");
});
