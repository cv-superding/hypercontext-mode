// #1916/#1307/#1314: dsh stamps ONE x-bili-plugin-conversation id on every
// model request of a session — including the auto-review classifyRisk()
// calls (fixed REVIEW_POLICY system + a freshly-flattened user blob, fired
// before every tool call under the Auto permission tier). The persona
// fingerprint keys dsh traffic by id + system hash (kernel subagentNamespace
// anchor semantics): the FIRST system seen under the id keeps the raw key
// (the main turn claims it), a different system forks onto `<id>|sub:<fp>`
// (the review persona), so review traffic stops overwriting the main
// session's usage baseline (#1916) and evicting its remembered snapshots
// (#1307). Successive review calls share ONE forked session. Allowlisted by
// plugin agent (dshPersonaFingerprintApplies) — other agents keep verbatim
// keying (#1106: system drift mid-id means "same conversation, evolved").

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { dshPersonaFingerprintApplies, openaiSystemTextForPersona } from "../src/session-id.ts";
// #2989: rig hygiene resets the LIVE session-order registry (the persona-
// anchor ladder is off the production path on every lane since #3134 —
// v2 order resolution everywhere, google included; this import was
// dead — never called — and its absence leaked skeletons across rigs).
import { resetSessionOrderForTest } from "../src/session-resolve.ts";
import { _rememberedForTest, _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, peekSession, _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const MODEL = "claude-sonnet-4-5";
const MAIN_SYSTEM = "You are DeepSeek Harness, the main coding agent.\nWorkspace: /tmp.";
const REVIEW_SYSTEM = "You are the final authorization reviewer for exactly one pending tool call.\nAnswer with one word.";
const SIDE_SYSTEM = "You are a title generator. Write one short title for the conversation.";

const forkKey = (conv: string, system: string): string =>
    `${conv}|sub:${createHash("sha256").update(system, "utf8").digest("hex").slice(0, 16)}`;

test("dshPersonaFingerprintApplies: allowlist is the dsh plugin agent only", () => {
    assert.equal(dshPersonaFingerprintApplies({ "x-bili-plugin": "dsh" }), true);
    assert.equal(dshPersonaFingerprintApplies({ "x-bili-plugin": " dsh " }), true, "trimmed match");
    assert.equal(dshPersonaFingerprintApplies({ "x-bili-plugin": "pi" }), false);
    assert.equal(dshPersonaFingerprintApplies({ "x-bili-plugin": "test-agent" }), false);
    assert.equal(dshPersonaFingerprintApplies({}), false);
    assert.equal(dshPersonaFingerprintApplies({ "x-bili-plugin": ["dsh"] }), false, "array form is not the dsh lane shape");
});

test("openaiSystemTextForPersona: joins every system message's text", () => {
    assert.equal(openaiSystemTextForPersona({ messages: [] }), "");
    assert.equal(openaiSystemTextForPersona({ messages: [{ role: "user", content: "hi" }] }), "");
    assert.equal(
        openaiSystemTextForPersona({ messages: [{ role: "system", content: "A" }, { role: "user", content: "u" }, { role: "system", content: "B" }] }),
        "A\n\nB",
    );
    assert.equal(
        openaiSystemTextForPersona({
            messages: [{ role: "system", content: [{ type: "text", text: "part-1" }, { type: "text", text: "part-2" }] }],
        }),
        "part-1\n\npart-2",
        "text parts are joined",
    );
    assert.equal(
        openaiSystemTextForPersona({ messages: [{ role: "system", content: [{ type: "image_url", image_url: { url: "x" } }] }] }),
        "",
        "non-text parts contribute nothing",
    );
});

type Rig = { proxyPort: number; upstreamPort: number; proxy: http.Server; upstream: http.Server };

type UpstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const chatCompletionUpstream: UpstreamHandler = (req, res) => {
    let b = "";
    req.on("data", (c: Buffer) => (b += c.toString("utf8")));
    req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }));
    });
};

async function startRig(upstreamHandler: UpstreamHandler = chatCompletionUpstream): Promise<Rig> {
    const upstream = http.createServer(upstreamHandler);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetSessionOrderForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxyPort: (proxy.address() as { port: number }).port, upstreamPort, proxy, upstream };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

const mainMsgs = (n: number): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i): { role: string; content: string } => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `main-${i + 1}-` + "z".repeat(6000),
    }));

test("e2e openai lane: review persona forks onto `|sub:<fp>`; main session untouched; forks are stable", async () => {
    const rig = await startRig();
    const CONV = "dshp-openai";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
        const tools = [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: {} } } }];

        // Phase 1 — main turn claims the raw key (anchor: MAIN_SYSTEM).
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools, messages: [{ role: "system", content: MAIN_SYSTEM }, ...mainMsgs(12)] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();
        const main = getSession(CONV);
        assert.ok(main, "main session exists under the raw conversation key");
        assert.ok(Object.keys(main.state.messageRefs.byRaw).length >= 12, "refs assigned to the main history");
        assert.ok((_rememberedForTest().get(CONV)?.processed.length ?? 0) >= 12, "remembered snapshot holds the main view");

        // Phase 2 — auto-review shape (fixed REVIEW_POLICY system + flattened
        // blob) under the SAME conversation id: forks onto `|sub:<fp>`.
        const review = (blob: string) => ({
            model: MODEL,
            max_tokens: 384_000,
            messages: [
                { role: "system", content: REVIEW_SYSTEM },
                { role: "user", content: `Conversation transcript (flattened):\n${blob}\nDecide: risky?` },
            ],
        });
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify(review("user: build it\nassistant: ok")) });
        assert.equal(r2.status, 200);
        await r2.text();
        const fork = forkKey(CONV, REVIEW_SYSTEM);
        const fk = peekSession(fork);
        assert.ok(fk, "review request landed on its own forked session");
        assert.equal((_rememberedForTest().get(CONV)?.processed.length ?? 0) >= 12, true, "main snapshot untouched (the review never even reached the main session)");
        assert.equal(getSession(CONV)?.stats.requests, 1, "main session request count unchanged by the review");
        assert.equal(fk.stats.requests, 1, "forked session served the review");

        // Phase 3 — a second review (same policy system, fresh blob) reuses
        // the SAME forked session (persona stability, not a fork per call).
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify(review("user: build it again\nassistant: done")) });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.equal(getSession(fork)?.stats.requests, 2, "successive reviews share one forked session");
        assert.equal(getSession(CONV)?.stats.requests, 1, "main session still at one request");

        // Phase 4 — a main turn (MAIN_SYSTEM) keeps the raw key (anchor).
        const r4 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools, messages: [{ role: "system", content: MAIN_SYSTEM }, ...mainMsgs(4)] }),
        });
        assert.equal(r4.status, 200);
        await r4.text();
        assert.equal(getSession(CONV)?.stats.requests, 2, "main turn still rides the raw key");

        // Phase 5 — conversations map discipline (#970): the raw key points at
        // the MAIN session even though the fork recorded itself; the fork is
        // reachable under its own suffixed id. (peekSession — getSession is
        // get-or-create and would mint the very session we are checking for.)
        const mainId = getSession(CONV).id;
        assert.equal(resolveConversation(CONV)?.entry?.sessionId, mainId, "raw conversation key still resolves to the main session id");
        assert.equal(resolveConversation(fork)?.entry?.sessionId, fk.id, "forked conversation key resolves to the forked session");

        // Phase 6 — a system-less auxiliary call is non-anchoring: verbatim
        // key, rides the main session (kernel empty-instructions path).
        const r5 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: mainMsgs(1) }) });
        assert.equal(r5.status, 200);
        await r5.text();
        assert.equal(getSession(CONV)?.stats.requests, 3, "system-less request keeps the raw key");
    } finally {
        await closeRig(rig);
    }
});

test("e2e anthropic lane: the same persona fork applies to dsh-over-anthropic", async () => {
    const rig = await startRig();
    const CONV = "dshp-anthropic";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
        const turn = (system: string, n: number) => ({
            model: MODEL,
            max_tokens: 64_000,
            system: [{ type: "text", text: system }],
            messages: Array.from({ length: n }, (_, i): { role: string; content: { type: string; text: string }[] } => ({
                role: i % 2 === 0 ? "user" : "assistant",
                content: [{ type: "text", text: `main-${i + 1}-` + "z".repeat(6000) }],
            })),
        });
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify(turn(MAIN_SYSTEM, 12)) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.ok(getSession(CONV), "main session exists under the raw key");
        assert.ok(Object.keys(getSession(CONV).state.messageRefs.byRaw).length >= 12, "refs assigned");

        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 384_000,
                system: [{ type: "text", text: REVIEW_SYSTEM }],
                messages: [{ role: "user", content: [{ type: "text", text: "Conversation transcript (flattened):\nuser: build it\nDecide: risky?" }] }],
            }),
        });
        assert.equal(r2.status, 200);
        await r2.text();
        const fork = forkKey(CONV, REVIEW_SYSTEM);
        assert.ok(peekSession(fork), "review request forked onto its own session on the anthropic lane too");
        assert.equal(peekSession(CONV)?.stats.requests, 1, "main session untouched by the review");
    } finally {
        await closeRig(rig);
    }
});

test("e2e responses lane #2203: review persona forks onto `|sub:<fp>`; main session untouched; forks are stable", async () => {
    const rig = await startRig((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "resp_1",
                object: "response",
                status: "completed",
                output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
                usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
            }));
        });
    });
    const CONV = "dshp-responses";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/responses`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
        const tools = [{ type: "function", name: "bash", description: "run", parameters: { type: "object", properties: {} } }];

        // Phase 1 — main turn claims the raw key (anchor: MAIN_SYSTEM as `instructions`).
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_output_tokens: 64_000, instructions: MAIN_SYSTEM, input: mainMsgs(12), tools }),
        });
        assert.equal(r1.status, 200);
        await r1.text();
        const main = getSession(CONV);
        assert.ok(main, "main session exists under the raw conversation key");
        assert.ok(Object.keys(main.state.messageRefs.byRaw).length >= 12, "refs assigned to the main history");
        assert.ok((_rememberedForTest().get(CONV)?.processed.length ?? 0) >= 12, "remembered snapshot holds the main view");

        // Phase 2 — auto-review shape (fixed REVIEW_POLICY instructions +
        // flattened blob) under the SAME conversation id: forks onto
        // `|sub:<fp>` (#2203 — before the fix this request rode the main
        // session on the responses wire and clobbered its snapshot/baseline).
        const review = (blob: string) => ({
            model: MODEL,
            max_output_tokens: 384_000,
            instructions: REVIEW_SYSTEM,
            input: [{ role: "user", content: `Conversation transcript (flattened):\n${blob}\nDecide: risky?` }],
        });
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify(review("user: build it\nassistant: ok")) });
        assert.equal(r2.status, 200);
        await r2.text();
        const fork = forkKey(CONV, REVIEW_SYSTEM);
        const fk = peekSession(fork);
        assert.ok(fk, "review request landed on its own forked session");
        assert.equal((_rememberedForTest().get(CONV)?.processed.length ?? 0) >= 12, true, "main snapshot untouched (the review never even reached the main session)");
        assert.equal(getSession(CONV)?.stats.requests, 1, "main session request count unchanged by the review");
        assert.equal(fk.stats.requests, 1, "forked session served the review");
        assert.equal(fk.metadata.personaNamespace, true, "fork stamped as a designed split (canary exemption, #2170 measure 4)");
        assert.notEqual(getSession(CONV)?.metadata.personaNamespace, true, "main session is not namespaced");

        // Phase 3 — a second review (same policy instructions, fresh blob)
        // reuses the SAME forked session (persona stability, not a fork per call).
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify(review("user: build it again\nassistant: done")) });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.equal(getSession(fork)?.stats.requests, 2, "successive reviews share one forked session");
        assert.equal(getSession(CONV)?.stats.requests, 1, "main session still at one request");

        // Phase 4 — a main turn (MAIN_SYSTEM) keeps the raw key (anchor).
        const r4 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_output_tokens: 64_000, instructions: MAIN_SYSTEM, input: mainMsgs(4), tools }),
        });
        assert.equal(r4.status, 200);
        await r4.text();
        assert.equal(getSession(CONV)?.stats.requests, 2, "main turn still rides the raw key");

        // Phase 5 — conversations map discipline (#970/#2156): the raw key
        // points at the MAIN session even though the fork recorded itself
        // (before the rawPersonaIdentity extension, the fork would have
        // recorded under the raw id and flipped this map entry).
        const mainId = getSession(CONV).id;
        assert.equal(resolveConversation(CONV)?.entry?.sessionId, mainId, "raw conversation key still resolves to the main session id");
        assert.equal(resolveConversation(fork)?.entry?.sessionId, fk.id, "forked conversation key resolves to the forked session");

        // Phase 6 — an instructions-less auxiliary call is non-anchoring:
        // verbatim key, rides the main session (kernel empty-instructions path).
        const r5 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_output_tokens: 64_000, input: mainMsgs(1) }) });
        assert.equal(r5.status, 200);
        await r5.text();
        assert.equal(getSession(CONV)?.stats.requests, 3, "instructions-less request keeps the raw key");
    } finally {
        await closeRig(rig);
    }
});

// #2156: a side request (title-gen shape: tiny budget, no tools, its own
// utility system) arriving FIRST under the conversation id used to claim the
// persona anchor — the kernel's first-seen-system rule anchored its system on
// the raw key, so every real main turn forked onto `|sub:<fp(main)>` and the
// host-stamped bare id found zero refs: compress failed permanently. Side
// requests must resolve verbatim: they never touch kernel state (#388), so
// they must neither read nor write the anchor. A later facet of the same
// mechanism: once any main turn had anchored, side requests rode junk
// `|sub:<fp(side)>` sessions instead of sharing the main key.
test("e2e openai lane #2156: side request FIRST must not steal the persona anchor", async () => {
    const rig = await startRig();
    const CONV = "dshp-sidefirst";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
        const tools = [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: {} } } }];
        const side = () => ({ model: MODEL, max_tokens: 100, messages: [{ role: "system", content: SIDE_SYSTEM }, { role: "user", content: "Summarize this conversation in one short title." }] });

        // Phase 1 — the side request arrives BEFORE any main turn (the race).
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify(side()) });
        assert.equal(r1.status, 200);
        await r1.text();
        const s1 = peekSession(CONV);
        assert.ok(s1, "side request resolved onto the raw conversation key (#388: side requests share the main key)");
        assert.equal(Object.keys(s1.state.messageRefs.byRaw).length, 0, "side passthrough touches no kernel state");
        assert.equal(s1.stats.requests, 0, "side passthrough counts no requests");
        assert.ok(!peekSession(forkKey(CONV, SIDE_SYSTEM)), "no junk |sub:<fp(side)> session");

        // Phase 2 — the FIRST main turn keeps the raw key even though a side
        // request arrived before it (the anchor-steal repro).
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools, messages: [{ role: "system", content: MAIN_SYSTEM }, ...mainMsgs(12)] }),
        });
        assert.equal(r2.status, 200);
        await r2.text();
        const main = peekSession(CONV);
        assert.ok(main, "main session exists under the RAW key");
        assert.ok(Object.keys(main.state.messageRefs.byRaw).length >= 12, "refs assigned under the bare id — compress with the host-stamped id works");
        assert.ok(!peekSession(forkKey(CONV, MAIN_SYSTEM)), "main turn did NOT fork onto |sub:<fp(main)>");
        assert.equal(main.stats.requests, 1, "exactly the main turn counted under the raw key");

        // Phase 3 — a LATER side request still rides the raw key (second facet:
        // pre-fix it minted a junk |sub:<fp(side)> session once anchored).
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify(side()) });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.ok(!peekSession(forkKey(CONV, SIDE_SYSTEM)), "post-anchor side request did not mint a junk forked session");
        assert.equal(peekSession(CONV)?.stats.requests, 1, "side request counted nowhere");

        // Phase 4 — review persona still forks (the #1916 mechanism this fix
        // must not disturb): full-pipeline request, own system, own fork.
        const r4 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 384_000,
                messages: [
                    { role: "system", content: REVIEW_SYSTEM },
                    { role: "user", content: "Conversation transcript (flattened):\nuser: build it\nassistant: ok\nDecide: risky?" },
                ],
            }),
        });
        assert.equal(r4.status, 200);
        await r4.text();
        const fork = peekSession(forkKey(CONV, REVIEW_SYSTEM));
        assert.ok(fork, "review persona still forks onto |sub:<fp> after the fix");
        assert.equal(peekSession(CONV)?.stats.requests, 1, "main session untouched by the review");
    } finally {
        await closeRig(rig);
    }
});

test("e2e anthropic lane #2156: the same anchor-steal race on dsh-over-anthropic", async () => {
    const rig = await startRig();
    const CONV = "dshp-sidefirst-anthropic";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
        const side = () => ({
            model: MODEL,
            max_tokens: 100,
            system: [{ type: "text", text: SIDE_SYSTEM }],
            messages: [{ role: "user", content: [{ type: "text", text: "Summarize this conversation in one short title." }] }],
        });

        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify(side()) });
        assert.equal(r1.status, 200);
        await r1.text();
        const s1 = peekSession(CONV);
        assert.ok(s1, "side request resolved onto the raw conversation key");
        assert.equal(Object.keys(s1.state.messageRefs.byRaw).length, 0, "side passthrough touches no kernel state");

        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 64_000,
                system: [{ type: "text", text: MAIN_SYSTEM }],
                messages: Array.from({ length: 12 }, (_, i): { role: string; content: { type: string; text: string }[] } => ({
                    role: i % 2 === 0 ? "user" : "assistant",
                    content: [{ type: "text", text: `main-${i + 1}-` + "z".repeat(6000) }],
                })),
            }),
        });
        assert.equal(r2.status, 200);
        await r2.text();
        const main = peekSession(CONV);
        assert.ok(main, "main session exists under the RAW key");
        assert.ok(Object.keys(main.state.messageRefs.byRaw).length >= 12, "refs assigned under the bare id");
        assert.ok(!peekSession(forkKey(CONV, MAIN_SYSTEM)), "main turn did NOT fork onto |sub:<fp(main)>");
    } finally {
        await closeRig(rig);
    }
});

test("e2e allowlist pin: a non-dsh plugin agent with two different systems stays on ONE session", async () => {
    const rig = await startRig();
    const CONV = "dshp-plain";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "test-agent", "x-bili-plugin-conversation": CONV };
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...mainMsgs(2)] }),
        });
        await r1.text();
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: REVIEW_SYSTEM }, { role: "user", content: "risky?" }] }),
        });
        await r2.text();
        assert.ok(peekSession(CONV), "session exists under the raw key");
        assert.equal(peekSession(CONV)?.stats.requests, 2, "both requests rode the same session — no persona fork for non-dsh agents (#1106 verbatim keying)");
        assert.ok(!peekSession(forkKey(CONV, REVIEW_SYSTEM)), "no forked session was created");
    } finally {
        await closeRig(rig);
    }
});

// #2730: the google lane now gets the same persona keying as openai/anthropic/
// responses. Before this, google requests ALWAYS keyed verbatim (rawPersonaIdentity
// had no google case), so a dsh review persona riding gemini would merge into the
// main session exactly like #1916/#2203 did on the other wires. dsh CAN route
// google: it stamps x-bili-plugin: dsh wire-agnostically (dsh-native.ts) and its
// MODEL_API_SUFFIX gate accepts google paths.
test("e2e google lane #2730: review persona forks onto `|sub:<fp>`; main session untouched; forks are stable", async () => {
    const rig = await startRig((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
                modelVersion: "gemini-test",
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
            }));
        });
    });
    const CONV = "dshp-google";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1beta/models/gemini-test:generateContent`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
        const gContents = (n: number): { role: string; parts: { text: string }[] }[] =>
            Array.from({ length: n }, (_, i): { role: string; parts: { text: string }[] } => ({
                role: i % 2 === 0 ? "user" : "model",
                parts: [{ text: `main-${i + 1}-` + "z".repeat(6000) }],
            }));

        // Phase 1 — main turn claims the raw key (anchor: MAIN_SYSTEM as systemInstruction).
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ contents: gContents(12), systemInstruction: { parts: [{ text: MAIN_SYSTEM }] }, generationConfig: { maxOutputTokens: 64_000 } }) });
        assert.equal(r1.status, 200);
        await r1.text();
        const main = getSession(CONV);
        assert.ok(main, "main session exists under the raw conversation key");
        assert.ok(Object.keys(main.state.messageRefs.byRaw).length >= 12, "refs assigned to the main history");
        assert.ok((_rememberedForTest().get(CONV)?.processed.length ?? 0) >= 12, "remembered snapshot holds the main view");

        // Phase 2 — auto-review shape (fixed REVIEW_POLICY systemInstruction +
        // flattened blob) under the SAME conversation id: forks onto `|sub:<fp>`.
        const review = (blob: string) => ({
            contents: [{ role: "user", parts: [{ text: `Conversation transcript (flattened):\n${blob}\nDecide: risky?` }] }],
            systemInstruction: { parts: [{ text: REVIEW_SYSTEM }] },
            generationConfig: { maxOutputTokens: 384_000 },
        });
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify(review("user: build it\nassistant: ok")) });
        assert.equal(r2.status, 200);
        await r2.text();
        const fork = forkKey(CONV, REVIEW_SYSTEM);
        const fk = peekSession(fork);
        assert.ok(fk, "review request landed on its own forked session on the google lane too");
        assert.equal((_rememberedForTest().get(CONV)?.processed.length ?? 0) >= 12, true, "main snapshot untouched (the review never even reached the main session)");
        assert.equal(getSession(CONV)?.stats.requests, 1, "main session request count unchanged by the review");
        assert.equal(fk.stats.requests, 1, "forked session served the review");
        assert.equal(fk.metadata.personaNamespace, true, "fork stamped as a designed split (canary exemption, #2170 measure 4)");
        assert.notEqual(getSession(CONV)?.metadata.personaNamespace, true, "main session is not namespaced");

        // Phase 3 — a second review (same policy systemInstruction, fresh blob)
        // reuses the SAME forked session (persona stability, not a fork per call).
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify(review("user: build it again\nassistant: done")) });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.equal(getSession(fork)?.stats.requests, 2, "successive reviews share one forked session");
        assert.equal(getSession(CONV)?.stats.requests, 1, "main session still at one request");

        // Phase 4 — a main turn (MAIN_SYSTEM) keeps the raw key (anchor).
        const r4 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ contents: gContents(4), systemInstruction: { parts: [{ text: MAIN_SYSTEM }] }, generationConfig: { maxOutputTokens: 64_000 } }) });
        assert.equal(r4.status, 200);
        await r4.text();
        assert.equal(getSession(CONV)?.stats.requests, 2, "main turn still rides the raw key");

        // Phase 5 — conversations map discipline (#970/#2156): the raw key points
        // at the MAIN session even though the fork recorded itself under its
        // suffixed id (before the rawPersonaIdentity google case, the fork would
        // have recorded under the raw id and flipped this map entry).
        const mainId = getSession(CONV).id;
        assert.equal(resolveConversation(CONV)?.entry?.sessionId, mainId, "raw conversation key still resolves to the main session id");
        assert.equal(resolveConversation(fork)?.entry?.sessionId, fk.id, "forked conversation key resolves to the forked session");

        // Phase 6 — a systemInstruction-less auxiliary call is non-anchoring:
        // verbatim key, rides the main session (kernel empty-instructions path).
        const r5 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 64_000 } }) });
        assert.equal(r5.status, 200);
        await r5.text();
        assert.equal(getSession(CONV)?.stats.requests, 3, "systemInstruction-less request keeps the raw key");
    } finally {
        await closeRig(rig);
    }
});

test("e2e google lane allowlist pin: a non-dsh plugin agent with two different systems stays on ONE session", async () => {
    const rig = await startRig((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } }));
        });
    });
    const CONV = "dshp-google-plain";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1beta/models/gemini-test:generateContent`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "test-agent", "x-bili-plugin-conversation": CONV };
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "u1" }] }], systemInstruction: { parts: [{ text: MAIN_SYSTEM }] }, generationConfig: { maxOutputTokens: 64_000 } }) });
        await r1.text();
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "risky?" }] }], systemInstruction: { parts: [{ text: REVIEW_SYSTEM }] }, generationConfig: { maxOutputTokens: 64_000 } }) });
        await r2.text();
        assert.ok(peekSession(CONV), "session exists under the raw key");
        assert.equal(peekSession(CONV)?.stats.requests, 2, "both requests rode the same session — no persona fork for non-dsh agents on the google lane (#1106 verbatim keying)");
        assert.ok(!peekSession(forkKey(CONV, REVIEW_SYSTEM)), "no forked session was created");
    } finally {
        await closeRig(rig);
    }
});

// #3134: cross-lane consistency — the google lane rides the SAME v2 order
// resolver as the other lanes since #3134 (#3060 migrated four call sites;
// the google one was left on the retired v1 personaNamespace ladder, its
// import restored by a9378038). ONE dsh conversation id may be stamped on
// requests that travel DIFFERENT wires (main turns on one, an auto-review
// persona on another); persona attribution must not depend on which wire
// carried the request: the aux persona forks onto its own `|sub:<fp>` key
// on BOTH wires (the fp is over the persona system text — lane-independent,
// so the same persona converges on ONE fork session), and the main
// conversation keeps the raw key on both.
test("e2e cross-lane #3134: one dsh conversation id across google + openai lanes keys personas consistently", async () => {
    const rig = await startRig((req, res) => {
        req.resume();
        req.on("end", () => {
            const google = (req.url ?? "").includes("v1beta");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(google
                ? {
                    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
                    modelVersion: "gemini-test",
                    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
                }
                : {
                    id: "chatcmpl-1",
                    object: "chat.completion",
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
                }));
        });
    });
    const CONV = "dshp-xlane";
    const openaiUrl = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
    const googleUrl = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1beta/models/gemini-test:generateContent`;
    const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
    try {
        const gContents = (n: number): { role: string; parts: { text: string }[] }[] =>
            Array.from({ length: n }, (_, i): { role: string; parts: { text: string }[] } => ({
                role: i % 2 === 0 ? "user" : "model",
                parts: [{ text: `main-${i + 1}-` + "z".repeat(6000) }],
            }));

        // Phase 1 — openai main turn (MAIN_SYSTEM) claims the raw key.
        const r1 = await fetch(openaiUrl, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages: [{ role: "system", content: MAIN_SYSTEM }, ...mainMsgs(12)] }) });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.ok(getSession(CONV), "main session exists under the raw conversation key (openai main turn claimed it)");
        assert.equal(getSession(CONV)?.stats.requests, 1, "one main request on the raw key");

        // Phase 2 — the review persona rides the GOOGLE wire (same id, fixed
        // REVIEW_POLICY systemInstruction + flattened blob): forks `|sub:<fp>`.
        const r2 = await fetch(googleUrl, { method: "POST", headers, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Conversation transcript (flattened):\nuser: build it\nassistant: ok\nDecide: risky?" }] }], systemInstruction: { parts: [{ text: REVIEW_SYSTEM }] }, generationConfig: { maxOutputTokens: 384_000 } }) });
        assert.equal(r2.status, 200);
        await r2.text();
        const fork = forkKey(CONV, REVIEW_SYSTEM);
        assert.ok(peekSession(fork), "review persona on the google wire forked onto its own `|sub:` key");
        assert.equal(getSession(CONV)?.stats.requests, 1, "raw key untouched by the google-wire review");
        assert.equal(peekSession(fork)?.stats.requests, 1, "forked session served the google-wire review");

        // Phase 3 — the SAME review persona rides the openai wire: same fp,
        // same fork key — ONE fork session across wires, not one per lane.
        const r3 = await fetch(openaiUrl, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 384_000, messages: [{ role: "system", content: REVIEW_SYSTEM }, { role: "user", content: "Conversation transcript (flattened):\nuser: build it again\nassistant: done\nDecide: risky?" }] }) });
        assert.equal(r3.status, 200);
        await r3.text();
        assert.equal(peekSession(fork)?.stats.requests, 2, "same persona on the openai wire reused the SAME forked session (cross-lane attribution consistency)");
        assert.equal(getSession(CONV)?.stats.requests, 1, "main session still untouched");

        // Phase 4 — a google-wire main turn keeps the raw key.
        const r4 = await fetch(googleUrl, { method: "POST", headers, body: JSON.stringify({ contents: gContents(12), systemInstruction: { parts: [{ text: MAIN_SYSTEM }] }, generationConfig: { maxOutputTokens: 64_000 } }) });
        assert.equal(r4.status, 200);
        await r4.text();
        assert.equal(getSession(CONV)?.stats.requests, 2, "google-wire main turn keeps the raw key (persona attribution is wire-independent)");

        // Phase 5 — conversations map discipline (#970): the raw key keeps
        // resolving to the MAIN session despite the cross-wire fork.
        assert.equal(resolveConversation(CONV)?.entry?.sessionId, getSession(CONV)?.id, "raw conversation key still resolves to the main session");
        assert.equal(resolveConversation(fork)?.entry?.sessionId, peekSession(fork)?.id, "fork key resolves to the forked session");
    } finally {
        await closeRig(rig);
    }
});
