import assert from "node:assert";
import http from "node:http";
import test from "node:test";

process.env.NODE_ENV = "test";

import {
    runReasoningGuard,
    tierN,
    inContinueWindow,
    reasoningGuardEngages,
    hasEncryptedContent,
    continueReason,
    sumUsage,
    agentUsage,
    nextRoundBody,
    commentaryNudge,
    buildTerminalEvent,
    type SseSink,
} from "../src/reasoning-guard.ts";

test("tierN maps 518n-2 lattice to tier index", () => {
    assert.strictEqual(tierN(516, 518, -2), 1);
    assert.strictEqual(tierN(1034, 518, -2), 2);
    assert.strictEqual(tierN(1552, 518, -2), 3);
    assert.strictEqual(tierN(517, 518, -2), null);
    assert.strictEqual(tierN(500, 518, -2), null);
    assert.strictEqual(tierN(518, 518, -2), null);
    assert.strictEqual(tierN(null, 518, -2), null);
});

test("inContinueWindow bounds the lattice tier", () => {
    assert.ok(inContinueWindow(1, 6));
    assert.ok(inContinueWindow(6, 6));
    assert.ok(!inContinueWindow(7, 6));
    assert.ok(inContinueWindow(99, 0));
    assert.ok(!inContinueWindow(null, 6));
    assert.ok(!inContinueWindow(0, 6));
});

test("reasoningGuardEngages gates on enabled only", () => {
    assert.ok(!reasoningGuardEngages(undefined));
    assert.ok(!reasoningGuardEngages({}));
    assert.ok(!reasoningGuardEngages({ enabled: false }));
    assert.ok(reasoningGuardEngages({ enabled: true }));
});

test("hasEncryptedContent inspects the last reasoning item", () => {
    assert.ok(!hasEncryptedContent([]));
    assert.ok(hasEncryptedContent([{ encrypted_content: "abc" }]));
    assert.ok(!hasEncryptedContent([{ encrypted_content: "" }]));
    assert.ok(!hasEncryptedContent([{}]));
    assert.ok(hasEncryptedContent([{ a: 1 }, { encrypted_content: "x" }]));
});

test("continueReason fires only within the lattice window", () => {
    assert.strictEqual(continueReason({ output_tokens_details: { reasoning_tokens: 516 } }, 518, -2, 6), "truncation");
    assert.strictEqual(continueReason({ output_tokens_details: { reasoning_tokens: 500 } }, 518, -2, 6), "");
    assert.strictEqual(continueReason(null, 518, -2, 6), "");
});

test("sumUsage accumulates token counters across rounds", () => {
    const acc: Record<string, unknown> = {};
    sumUsage(acc, { input_tokens: 100, output_tokens: 516, total_tokens: 616, output_tokens_details: { reasoning_tokens: 516 }, input_tokens_details: { cached_tokens: 40 } });
    sumUsage(acc, { input_tokens: 100, output_tokens: 1034, total_tokens: 1134, output_tokens_details: { reasoning_tokens: 1034 } });
    assert.strictEqual(acc.input_tokens, 200);
    assert.strictEqual(acc.output_tokens, 516 + 1034);
    assert.strictEqual(acc.total_tokens, 616 + 1134);
    assert.strictEqual((acc["output_tokens_details"] as Record<string, unknown>)["reasoning_tokens"], 516 + 1034);
    assert.strictEqual((acc["input_tokens_details"] as Record<string, unknown>)["cached_tokens"], 40);
});

test("agentUsage reports summed reasoning plus final non-reasoning part", () => {
    const first = { input_tokens: 100, output_tokens: 516, total_tokens: 616, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 516 } };
    const summed = { input_tokens: 200, output_tokens: 1550, total_tokens: 1650, output_tokens_details: { reasoning_tokens: 1550 } };
    const finalRound = { output_tokens: 1560, output_tokens_details: { reasoning_tokens: 1550 } };
    const u = agentUsage(first, summed, finalRound, true);
    assert.strictEqual(u.input_tokens, 100);
    assert.strictEqual(u.output_tokens, 1560);
    assert.strictEqual(u.total_tokens, 1660);
    assert.strictEqual((u["output_tokens_details"] as Record<string, unknown>)["reasoning_tokens"], 1550);
    assert.deepStrictEqual(u["input_tokens_details"], { cached_tokens: 40 });
});

test("nextRoundBody replays input, forces stream, adds encrypted include", () => {
    const base = { model: "gpt-5.5", stream: false, input: ["a"], include: [], previous_response_id: "prev" };
    const nb = nextRoundBody(base, ["a", "b"]);
    assert.strictEqual(nb.stream, true);
    assert.deepStrictEqual(nb.input, ["a", "b"]);
    assert.deepStrictEqual(nb.include, ["reasoning.encrypted_content"]);
    assert.strictEqual(nb.previous_response_id, undefined);
    const nb2 = nextRoundBody({ include: ["reasoning.encrypted_content", "other"] }, []);
    assert.deepStrictEqual(nb2.include, ["reasoning.encrypted_content", "other"]);
});

test("commentaryNudge builds a phase:commentary message", () => {
    const n = commentaryNudge("Keep going");
    assert.strictEqual(n.type, "message");
    assert.strictEqual(n.role, "assistant");
    assert.strictEqual(n.phase, "commentary");
    assert.deepStrictEqual(n.content, [{ type: "output_text", text: "Keep going" }]);
});

test("buildTerminalEvent stamps proxy metadata and honors incomplete", () => {
    const ok = buildTerminalEvent({
        upstreamTerminal: { type: "response.completed", response: { status: "completed", id: "r" } },
        baseResponse: { id: "r", model: "gpt-5.5" },
        output: [{ type: "message" }],
        usage: { input_tokens: 1 },
        rounds: [{ round: 1 }],
        billed: { input_tokens: 1 },
        stoppedReason: "",
        incompleteReason: "",
    });
    assert.strictEqual(ok.type, "response.completed");
    const r = ok.response as Record<string, unknown>;
    assert.strictEqual(r.status, "completed");
    assert.strictEqual(((r.metadata as Record<string, unknown>)["proxy_rounds"] as unknown[]).length, 1);

    const bad = buildTerminalEvent({
        upstreamTerminal: null,
        baseResponse: null,
        output: [],
        usage: {},
        rounds: [],
        billed: {},
        stoppedReason: "",
        incompleteReason: "upstream_eof",
    });
    assert.strictEqual(bad.type, "response.incomplete");
    assert.strictEqual((bad.response as Record<string, unknown>).status, "incomplete");
});

function sseRound(o: { reasoningTokens: number; encrypted?: string; messageText?: string; inputTokens?: number }): string {
    const inputTokens = o.inputTokens ?? 100;
    const nonReasoning = o.messageText ? 10 : 0;
    const outputTokens = o.reasoningTokens + nonReasoning;
    const events: Array<Record<string, unknown>> = [];
    events.push({ type: "response.created", response: { id: "resp_x", status: "in_progress", model: "gpt-5.5" } });
    events.push({ type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", status: "in_progress" } });
    const reasonDone: Record<string, unknown> = { id: "rs_1", type: "reasoning", status: "completed" };
    if (o.encrypted !== undefined) reasonDone.encrypted_content = o.encrypted;
    events.push({ type: "response.output_item.done", output_index: 0, item: reasonDone });
    let oi = 1;
    if (o.messageText) {
        events.push({ type: "response.output_item.added", output_index: oi, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } });
        events.push({ type: "response.output_item.done", output_index: oi, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: o.messageText }] } });
        oi++;
    }
    events.push({
        type: "response.completed",
        response: {
            id: "resp_x",
            status: "completed",
            model: "gpt-5.5",
            output: [],
            usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens, output_tokens_details: { reasoning_tokens: o.reasoningTokens } },
        },
    });
    let out = "";
    for (const e of events) out += `data: ${JSON.stringify(e)}\n\n`;
    out += "data: [DONE]\n\n";
    return out;
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(enc.encode(text));
            controller.close();
        },
    });
}

function makeSink(): { sink: SseSink; frames: string[] } {
    const frames: string[] = [];
    const sink: SseSink = {
        headersSent: false,
        writableEnded: false,
        writeHead() {
            sink.headersSent = true;
        },
        write(chunk) {
            frames.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
            return true;
        },
        end() {
            sink.writableEnded = true;
        },
        once() {
            return undefined;
        },
    };
    return { sink, frames };
}

function parseFrames(frames: string[]): Array<Record<string, unknown>> {
    const lines = frames.map((f) => f.trim()).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    const out: Array<Record<string, unknown>> = [];
    for (const l of lines) {
        if (l === "[DONE]") continue;
        out.push(JSON.parse(l) as Record<string, unknown>);
    }
    return out;
}

test("runReasoningGuard folds truncated gpt-5.5 rounds into one completed response", async () => {
    let contCount = 0;
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
            bodies.push(data);
            contCount++;
            const payload = contCount === 1
                ? sseRound({ reasoningTokens: 1034, encrypted: "enc2" })
                : sseRound({ reasoningTokens: 900, encrypted: "enc3", messageText: "The answer." });
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(payload);
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/v1/responses`;

    try {
        const firstResponse = new Response(streamFrom(sseRound({ reasoningTokens: 516, encrypted: "enc1" })), { headers: { "content-type": "text/event-stream" } });
        const { sink, frames } = makeSink();
        let cleared = 0;
        await runReasoningGuard({
            firstResponse,
            clearFirstTimer: () => {
                cleared++;
            },
            upstreamUrl: url,
            reqHeaders: { "content-type": "application/json" },
            originalBody: JSON.stringify({ model: "gpt-5.5", stream: true, input: [{ type: "message", role: "user", content: "hi" }] }),
            signal: new AbortController().signal,
            res: sink,
            config: { enabled: true },
            log: () => {},
        });

        assert.strictEqual(contCount, 2, "exactly two continuation rounds");
        assert.ok(cleared >= 1, "upstream idle timer cleared");
        const events = parseFrames(frames);
        const terminals = events.filter((e) => e.type === "response.completed" || e.type === "response.incomplete");
        assert.strictEqual(terminals.length, 1, "exactly one terminal event");
        const terminal = terminals[0];
        assert.strictEqual(terminal.type, "response.completed");
        const resp = terminal.response as Record<string, unknown>;
        assert.strictEqual(resp.status, "completed");
        const usage = resp.usage as Record<string, unknown>;
        assert.strictEqual((usage["output_tokens_details"] as Record<string, unknown>)["reasoning_tokens"], 516 + 1034 + 900);
        assert.strictEqual(usage.input_tokens, 100);
        assert.strictEqual(usage.output_tokens, 2450 + 10);
        assert.strictEqual(usage.total_tokens, 100 + 2460);
        const meta = resp.metadata as Record<string, unknown>;
        assert.strictEqual((meta["proxy_rounds"] as unknown[]).length, 3);
        const outputs = (resp.output ?? []) as Array<Record<string, unknown>>;
        assert.ok(outputs.some((it) => it.type === "message" && ((it.content ?? []) as Array<Record<string, unknown>>).some((c) => c.text === "The answer.")));

        assert.ok(bodies[0].includes("Continue thinking..."), "first continuation carries the nudge");
        assert.ok(bodies[0].includes("enc1"), "first continuation replays round-1 encrypted reasoning");
        assert.ok(bodies[1].includes("enc2"), "second continuation replays round-2 encrypted reasoning");
        assert.ok(bodies[0].includes("reasoning.encrypted_content"), "include carries encrypted_content");
    } finally {
        server.close();
    }
});

test("runReasoningGuard passes a clean single round through without continuation", async () => {
    const { sink, frames } = makeSink();
    const firstResponse = new Response(streamFrom(sseRound({ reasoningTokens: 800, encrypted: "enc1", messageText: "done" })), { headers: { "content-type": "text/event-stream" } });
    await runReasoningGuard({
        firstResponse,
        clearFirstTimer: () => {},
        upstreamUrl: "http://127.0.0.1:1/v1/responses",
        reqHeaders: { "content-type": "application/json" },
        originalBody: JSON.stringify({ model: "gpt-5.5", stream: true, input: [] }),
        signal: new AbortController().signal,
        res: sink,
        config: { enabled: true },
        log: () => {},
    });
    const events = parseFrames(frames);
    const terminals = events.filter((e) => e.type === "response.completed" || e.type === "response.incomplete");
    assert.strictEqual(terminals.length, 1);
    assert.strictEqual(terminals[0].type, "response.completed");
    const resp = terminals[0].response as Record<string, unknown>;
    const usage = resp.usage as Record<string, unknown>;
    assert.strictEqual((usage["output_tokens_details"] as Record<string, unknown>)["reasoning_tokens"], 800);
    const outputs = (resp.output ?? []) as Array<Record<string, unknown>>;
    assert.ok(outputs.some((it) => it.type === "message"));
});
