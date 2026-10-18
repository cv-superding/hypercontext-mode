// [#2867] The Responses self-heal lane degrades a zombie plugin session to
// proxy mode after five nudge rounds without x-bili-plugin (#2155). The two
// modes project mid-history system/developer items differently — plugin mode
// keeps them in place via __bili_inplace_sysdev (#1638), proxy mode hoists
// them into the front developer block (#1085) — so the forwarded system
// projection (and its fingerprint) changes even though the host changed no
// input byte. Before #2867 the cache ledger read every such flip as "host
// rewrote the system prompt" (#2350).
//
// Fix under test: prepareResponses records a mode-independent canonical
// incoming sys/dev fingerprint (session.metadata.canonicalSysFp) alongside
// the forwarded-projection fingerprint (systemFp) plus the request's mode
// (lastResponsesMode); settleUsageReport classifies a projection flip with a
// STABLE canonical view as cause "projection" and never books it under
// "prompt". No wire behavior changes — both projections keep their semantics.
//
// Pins:
//   T1 unit — canonicalResponsesSystem returns the ordered instructions-first
//             view of every sys/dev item regardless of position or mode;
//   T2 e2e  — t1 plugin bind, t2..t7 six headerless rounds (t2 is nudge-idle:
//             the kernel's first-turn tokenCount is 0, so growth reads 0; the
//             injected nudge lands t3..t7 — five nudge-active rounds, the
//             SELF_HEAL_WINDOW=5 zombie streak arms at end of t7), t8 = first
//             degraded proxy prepare: captured bodies show the mid-history
//             NOTIF moving from in-place to the front block while the cache
//             report attributes the prefix re-bill to PROJECTION SWITCHES and
//             never to PROMPT SWITCHES.

import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { rmrf } from "./tmp-rm.ts";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { canonicalResponsesSystem } from "../src/server/prepare-responses.ts";

const SYS = "MSF HOST SYSTEM v3 plan carefully";
const NOTIF = "mid-run-todo-nudge: 3 open todos in plan";
// Padded messages must be big enough that, once they leave the kernel's
// 5-message recent window, the merged range clears minCompressRange (5000
// chars) and T1 pending clears the 500-token threshold — otherwise
// decideNudge reports "max compressible 0" and no zombie round ever carries
// a nudge (the self-heal streak is nudgeActive-gated, #2155).
const FILLER = "padding payload ".repeat(230);

type CItem =
    | { kind: "dev"; text: string }
    | { kind: "message"; role: "user" | "assistant"; text: string; pad?: boolean };

interface Step {
    mode: "plugin" | "proxy";
    hist: CItem[];
}

function T(i: number, pad = false): CItem { return { kind: "message", role: "user", text: `msf turn ${i}`, pad }; }
function A(i: number, pad = false): CItem { return { kind: "message", role: "assistant", text: `msf reply ${i}`, pad }; }
function D(text: string): CItem { return { kind: "dev", text }; }

function buildBody(hist: CItem[]): Record<string, unknown> {
    const input = hist.map((it) =>
        it.kind === "dev"
            ? { role: "developer", content: it.text }
            : { type: "message", role: it.role, content: [{ type: it.role === "user" ? "input_text" : "output_text", text: it.text + (it.pad ? FILLER : "") }] },
    );
    // stream:true is load-bearing: only the streaming lane settles usage into
    // the cache ledger — the non-streaming branch JSON-parses the (SSE) reply,
    // fails, and passes it through with no accounting (#1547 shared settle
    // path), so the projection switch would never be observable.
    return { model: "gpt-test", stream: true, input };
}

// The devpos fixture carries no usage (billing lane out of scope there); the
// ledger settles on response.completed usage, so this variant reports a
// deterministic per-round sequence: warm ≈97% hit (≥ WARM_HIT_PCT 85) until
// FLIP_ROUND, where the re-projected prefix re-bills cold (cached=0).
const FLIP_ROUND = 8;
function usageFor(round: number): Record<string, unknown> {
    const input = 2_000 + (round - 1) * 1_330;
    const cached = round === FLIP_ROUND ? 0 : input - 330;
    return { input_tokens: input, output_tokens: 50, total_tokens: input + 50, input_tokens_details: { cached_tokens: cached } };
}

function sseText(text: string, round: number): string {
    // The completed frame's data must carry the {type, response:{...}} wrapper —
    // the adapter reads data.response.usage for ledger settlement; a bare
    // response object parses (the event: line still names the type) but yields
    // an empty usage, so no round ever settles and the report stays at 0.
    const events = [
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp-msf", status: "in_progress" } })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "msg-msf", type: "message", status: "in_progress", role: "assistant", content: [] } })}\n\n`,
        `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", item_id: "msg-msf", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg-msf", output_index: 0, content_index: 0, delta: text.slice(0, 8) })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg-msf", output_index: 0, content_index: 0, delta: text.slice(8) })}\n\n`,
        `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg-msf", output_index: 0, content_index: 0, text })}\n\n`,
        `event: response.content_part.done\ndata: ${JSON.stringify({ type: "response.content_part.done", item_id: "msg-msf", output_index: 0, content_index: 0, part: { type: "output_text", text } })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "msg-msf", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text }] } })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp-msf", object: "response", model: "gpt-test", output: [], status: "completed", usage: usageFor(round) } })}\n\n`,
    ];
    return events.join("");
}

function itemText(it: any): string {
    if (typeof it.content === "string") return it.content;
    if (Array.isArray(it.content)) return it.content.map((p: any) => typeof p?.text === "string" ? p.text : "").join("\n");
    return "";
}
function isSysDevItem(it: any): boolean {
    return (it.type === undefined || it.type === "message") && (it.role === "developer" || it.role === "system");
}
function sysDevTexts(body: any): string[] {
    const input = Array.isArray(body?.input) ? body.input : [];
    return input.filter(isSysDevItem).map(itemText);
}

async function driveModeSwitch(steps: Step[]): Promise<{ caps: Array<{ raw: string; body: any }>; md: string }> {
    const caps: Array<{ raw: string; body: any }> = [];
    let roundCounter = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            let body: any = undefined;
            try { body = raw ? JSON.parse(raw) : undefined; } catch { /* non-JSON probe */ }
            // Only real conversation POSTs count as rounds; the proxy also
            // probes the origin (billing/registry) with bodies that are not
            // Responses requests.
            if (!body || !Array.isArray(body.input)) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end("{}");
                return;
            }
            caps.push({ raw, body });
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(sseText(`answer-${caps.length}`, roundCounter++));
        });
    });
    await once(upstream.listen(0), "listening");
    const origin = `http://127.0.0.1:${(upstream.address() as any).port}`;

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-msf-state-"));
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();

    const conv = `msf-${Date.now().toString(36)}`;
    const opts = {
        host: "127.0.0.1",
        port: 0,
        routes: { [origin]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        // The kernel's flat nudge band (minGrowthFloor 20000) never fires on a
        // small hermetic fixture; lower it so per-round growth (~1K tokens)
        // clears the floor deterministically — same pattern as
        // issue2432-dsh-local-compaction.
        kernelConfig: { ...defaultConfig(400_000), nudge: { ...defaultConfig(400_000).nudge, minGrowthFloor: 100 } },
        compress: { injectTool: true, injectNudge: true, nudgeGrowthTokens: 500 },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        autoUpdate: false,
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false },
    } as unknown as ProxyOptions;
    const srv = await startServer(opts);
    await once(srv, "listening");
    const proxyPort = (srv.address() as any).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/${origin}`;

    try {
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i]!;
            const headers: Record<string, string> = { "content-type": "application/json" };
            if (step.mode === "plugin") {
                headers["x-bili-plugin"] = "omp-plugin/0.0.1";
                headers["x-bili-plugin-conversation"] = conv;
            } else {
                headers["x-acp-session"] = conv;
            }
            const resp = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify(buildBody(step.hist)) });
            assert.equal(resp.status, 200, `round ${i + 1} (${step.mode}) must stream 200`);
            await resp.arrayBuffer();
        }
        // The admin cache-report endpoint serves the same markdown the acp_cache
        // MCP tool emits (handleAcpCache detail:"full") — assert on that text.
        const rep = await fetch(`http://127.0.0.1:${proxyPort}/__bili/cache-report?session=${conv}`);
        assert.equal(rep.status, 200, "cache-report endpoint must answer");
        const rj = await rep.json() as { reports: Array<{ id: string; report: string }> };
        const md = rj.reports.find((r) => r.id === conv)?.report ?? "";
        return { caps, md };
    } finally {
        srv.close();
        await new Promise<void>((r) => upstream.close(() => r()));
        await rmrf(stateDir);
        delete process.env.XDG_STATE_HOME;
    }
}

test("canonicalResponsesSystem is the mode-independent incoming sys/dev view (#2867)", () => {
    const body = {
        model: "gpt-test",
        instructions: "HOST INSTRUCTIONS",
        input: [
            { type: "message", role: "developer", content: "HEAD DEV" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
            { type: "message", role: "system", content: [{ type: "input_text", text: "MID SYS PART 1" }, { type: "input_text", text: "MID SYS PART 2" }] },
            { type: "message", role: "user", content: "second question" },
        ],
    };
    assert.deepEqual(canonicalResponsesSystem(body), [
        { role: "instructions", text: "HOST INSTRUCTIONS" },
        { role: "developer", text: "HEAD DEV" },
        { role: "system", text: "MID SYS PART 1\nMID SYS PART 2" },
    ]);

    // Non-sys/dev items never enter the view; blank instructions are skipped.
    const bare = {
        model: "gpt-test",
        instructions: "   ",
        input: [
            { type: "function_call", name: "bash", arguments: "{}" },
            { type: "message", role: "user", content: "q" },
        ],
    };
    assert.deepEqual(canonicalResponsesSystem(bare), []);
});

test("self-heal degrade-to-proxy re-projects mid-history developer items without blaming the host (#2867)", async () => {
    const hist: CItem[] = [];
    const push = (...items: CItem[]) => { for (const it of items) hist.push(it); };
    const steps: Step[] = [];
    // Seed four padded turns BEFORE the scenario: by t3 enough mass must sit
    // OUTSIDE the kernel's 5-message recent window for a nudge to inject
    // (decideNudge needs minCompressRange + T1 threshold; the self-heal
    // streak only advances on nudge-active rounds, #2155).
    for (let i = -8; i < 0; i += 2) push(T(i, true), A(i + 1, true));
    // t1: plugin header binds metadata.pluginAgent; head developer only.
    push(D(SYS), T(1, true)); steps.push({ mode: "plugin", hist: [...hist] });
    // t2: first headerless round — nudge-idle (kernel first-turn tokenCount
    // is 0 → growth 0); a mid-history developer notification enters the
    // conversation (canon flips vs t1; sp stays stable under the plugin
    // in-place rules → cf observation only, no billing).
    push(A(2, true), D(NOTIF), T(3, true)); steps.push({ mode: "proxy", hist: [...hist] });
    // t3..t7: five more headerless rounds, each carrying the injected nudge →
    // zombie streak reaches SELF_HEAL_WINDOW=5 at the end of t7 →
    // armSelfHeal("plugin-lane-gone","degrade-to-proxy").
    for (const pair of [[4, 5], [6, 7], [8, 9], [10, 11], [12, 13]] as const) {
        push(A(pair[0], true), T(pair[1], true)); steps.push({ mode: "proxy", hist: [...hist] });
    }
    // t8: FIRST degraded proxy prepare — sp [SYS]→[SYS,NOTIF], canon stable.
    push(A(14, true), T(15, true)); steps.push({ mode: "proxy", hist: [...hist] });
    // t9: stability round, warm proxy.
    push(A(16, true), T(17, true)); steps.push({ mode: "proxy", hist: [...hist] });

    const { caps, md } = await driveModeSwitch(steps);
    assert.equal(caps.length, 9);

    const before = caps[6]!; // t7 — last request prepared in plugin mode
    assert.ok(sysDevTexts(before.body).some((t) => t.includes(SYS)), "head developer block forwarded");
    assert.ok(!sysDevTexts(before.body).some((t) => t.includes(NOTIF) && t.includes(SYS)), "mid-history NOTIF must stay OUT of the front block in plugin mode");
    assert.equal(sysDevTexts(before.body).filter((t) => t.includes(NOTIF)).length, 1, "NOTIF re-emitted in place (plugin position-preservation #1638)");
    for (const idx of [7, 8]) { // t8/t9 — degraded proxy prepares
        const texts = sysDevTexts(caps[idx]!.body);
        const front = texts[0] ?? "";
        assert.ok(front.includes(SYS) && front.includes(NOTIF), "degraded front block must hoist mid-history NOTIF (#1085)");
        assert.equal(texts.filter((t) => t.includes(NOTIF)).length, 1, "NOTIF appears exactly once (hoisted, no in-place copy)");
    }
    for (const c of caps) assert.ok(!c.raw.includes("__bili_inplace_sysdev"), "internal marker must never leak onto the wire");

    // The one re-projection re-billed cold and was attributed to the proxy's
    // own mode switch — never to a host rewrite.
    assert.ok(md.includes("PROJECTION SWITCHES"), "dedicated projection section expected:\n" + md);
    const projLine = md.match(/projection switch:[^\n]*\((\d+)\)/);
    assert.ok(projLine, "invalidation line with count expected");
    assert.ok(Number(projLine![1]) >= 1, "at least one projection switch event expected");
    assert.ok(!md.includes("PROMPT SWITCHES"), "no host-rewrite section for an unchanged incoming history:\n" + md);
    assert.ok(md.match(/prompt rewrite:[^\n]*\(0\)/), "prompt invalidation bucket must stay empty");
});
