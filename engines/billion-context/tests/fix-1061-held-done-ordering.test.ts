import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginResponsesWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

// #1061: the plugin passthrough pipe held done-family events until the
// completion event while forwarding output_item.added immediately, so a legal
// upstream stream with two reasoning items reached the client as added(rs_2)
// BEFORE done(rs_1). opencode v2 hard-rejects that order (InvalidProviderOutput:
// "started reasoning before the previous item ended", verified in
// packages/ai/src/protocols/open-responses.ts:1501-1507 @ v2.0.8).

function makeSession(): Session {
    return {
        id: "testsess",
        protocol: "responses",
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        stats: {},
        dirty: false,
    } as unknown as Session;
}

function makeRes(chunks: string[]) {
    return {
        writes: chunks,
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as import("node:http").ServerResponse;
}

function sse(event: string, data: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

const TAG_OPEN = "\x3cacp tokens=\"247\" type=\"text\"\x3e";
const TAG_CLOSE = "\x3c/acp\x3e";

/** Every data line the client received, in client-visible order. */
function frames(raw: string): Array<Record<string, unknown>> {
    return raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);
}

function itemId(ev: Record<string, unknown>): string | undefined {
    const item = ev["item"];
    if (item && typeof item === "object" && typeof (item as Record<string, unknown>)["id"] === "string") {
        return (item as Record<string, unknown>)["id"] as string;
    }
    return typeof ev["item_id"] === "string" ? (ev["item_id"] as string) : undefined;
}

function reasoningPart(itemId_: string, index: number, phase: "added" | "delta" | "done", text: string): string {
    if (phase === "added") {
        return sse("response.reasoning_summary_part.added", { item_id: itemId_, output_index: 0, summary_index: index, part: { type: "summary_text", text: "" } });
    }
    if (phase === "delta") {
        return sse("response.reasoning_summary_text.delta", { item_id: itemId_, output_index: 0, summary_index: index, delta: text });
    }
    return sse("response.reasoning_summary_part.done", { item_id: itemId_, output_index: 0, summary_index: index, text });
}

/** A fully legal upstream turn: two interleaved reasoning items, then the
 *  message — the exact shape gpt-5.x relays produce. */
function multiReasoningTurn(): string[] {
    return [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { output_index: 0, item: { id: "rs_1", type: "reasoning", status: "in_progress" } }),
        reasoningPart("rs_1", 0, "added", ""),
        reasoningPart("rs_1", 0, "delta", "thinking a"),
        reasoningPart("rs_1", 0, "done", "thinking a"),
        sse("response.output_item.done", { output_index: 0, item: { id: "rs_1", type: "reasoning", status: "completed", encrypted_content: "enc_a" } }),
        sse("response.output_item.added", { output_index: 1, item: { id: "rs_2", type: "reasoning", status: "in_progress" } }),
        reasoningPart("rs_2", 0, "added", ""),
        reasoningPart("rs_2", 0, "delta", "thinking b"),
        reasoningPart("rs_2", 0, "done", "thinking b"),
        sse("response.output_item.done", { output_index: 1, item: { id: "rs_2", type: "reasoning", status: "completed", encrypted_content: "enc_b" } }),
        sse("response.output_item.added", { output_index: 2, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
        sse("response.content_part.added", { item_id: "msg_1", output_index: 2, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 2, delta: "the answer" }),
        sse("response.output_text.done", { item_id: "msg_1", output_index: 2, text: "the answer" }),
        sse("response.content_part.done", { item_id: "msg_1", output_index: 2, part: { type: "output_text", text: "the answer" } }),
        sse("response.output_item.done", { output_index: 2, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "the answer" }] } }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } }),
    ];
}

test("#1061: done(itemN) reaches the client before added(itemN+1) on a multi-reasoning turn", async () => {
    const out: string[] = [];
    await pipePluginResponsesWithStrip(streamOf(multiReasoningTurn()), makeRes(out), makeSession());
    const fs = frames(out.join(""));
    const idx = (type: string, id?: string) => fs.findIndex((ev) => ev["type"] === type && (id === undefined || itemId(ev) === id));
    // The reported defect: done(rs_1) arrived 7 frames AFTER added(rs_2).
    assert.ok(idx("response.output_item.done", "rs_1") < idx("response.output_item.added", "rs_2"), "done(rs_1) must reach the client before added(rs_2)");
    assert.ok(idx("response.output_item.done", "rs_2") < idx("response.output_item.added", "msg_1"), "done(rs_2) must precede added(msg_1)");
    assert.ok(idx("response.output_item.done", "msg_1") < idx("response.completed"), "done(msg_1) must precede the terminal");
    assert.equal(fs.length, 18, "every upstream frame reaches the client exactly once");
});

test("#1061: the early release does not weaken the empty-turn retry gate", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(
            streamOf([
                sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
                sse("response.output_item.added", { output_index: 0, item: { id: "item_2", type: "message", content: [] } }),
                sse("response.content_part.added", { item_id: "item_2", output_index: 0, part: { type: "output_text", text: "" } }),
                sse("response.output_text.delta", { item_id: "item_2", output_index: 0, delta: "recovered after the nudge" }),
                sse("response.output_text.done", { item_id: "item_2", output_index: 0, text: "recovered after the nudge" }),
                sse("response.output_item.done", { output_index: 0, item: { id: "item_2", type: "message", content: [{ type: "output_text", text: "recovered after the nudge" }] } }),
                sse("response.completed", { response: { id: "resp_2", status: "completed", output: [] } }),
            ]),
        );
    };
    // Attempt 1: a complete reasoning item, then a message whose ONLY text is a
    // stripped render-tag echo — the degenerate turn the retry exists for.
    const attempt1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { output_index: 0, item: { id: "rs_1", type: "reasoning", status: "in_progress" } }),
        reasoningPart("rs_1", 0, "added", ""),
        reasoningPart("rs_1", 0, "delta", "thinking"),
        reasoningPart("rs_1", 0, "done", "thinking"),
        sse("response.output_item.done", { output_index: 0, item: { id: "rs_1", type: "reasoning", status: "completed" } }),
        sse("response.output_item.added", { output_index: 1, item: { id: "msg_1", type: "message", content: [] } }),
        sse("response.content_part.added", { item_id: "msg_1", output_index: 1, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 1, delta: `${TAG_OPEN}m00155${TAG_CLOSE}` }),
        sse("response.output_text.done", { item_id: "msg_1", output_index: 1, text: `${TAG_OPEN}m00155${TAG_CLOSE}` }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(attempt1), makeRes(out), makeSession(), undefined, refetch);
    const text = out.join("");
    const fs = frames(text);
    assert.equal(calls, 1, "the echo-only turn is still retried exactly once");
    // Pre-fix, done(rs_1) was held to the terminal and DROPPED by the retry
    // takeover, so the client's first reasoning item never closed.
    const doneRs1 = fs.findIndex((ev) => ev["type"] === "response.output_item.done" && itemId(ev) === "rs_1");
    const addedMsg = fs.findIndex((ev) => ev["type"] === "response.output_item.added" && itemId(ev) === "msg_1");
    assert.ok(doneRs1 >= 0, "done(rs_1) must reach the client instead of being dropped by the retry");
    assert.ok(doneRs1 < addedMsg, "done(rs_1) must precede added(msg_1)");
    const retryDelta = fs.find((ev) => ev["type"] === "response.output_text.delta" && ev["delta"] === "recovered after the nudge");
    assert.ok(retryDelta, "the retry's prose reaches the client");
    assert.equal(retryDelta?.["item_id"], "msg_1", "the retry is reframed onto the item id the client holds");
    assert.ok(!text.includes("item_2") && !text.includes("resp_2"), "no retry-side ids leak");
    assert.equal(fs.filter((ev) => ev["type"] === "response.completed").length, 1, "one turn, one terminal");
    assert.equal(fs.filter((ev) => ev["type"] === "response.output_item.added" && itemId(ev) === "msg_1").length, 1, "the retry's own added stays dropped");
});

test("#1061: the retry stream's own reasoning surface carries no leaked ids", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(
            streamOf([
                sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
                sse("response.output_item.added", { output_index: 0, item: { id: "rs_9", type: "reasoning", status: "in_progress" } }),
                reasoningPart("rs_9", 0, "added", ""),
                reasoningPart("rs_9", 0, "delta", "retry thinking"),
                reasoningPart("rs_9", 0, "done", "retry thinking"),
                sse("response.output_item.done", { output_index: 0, item: { id: "rs_9", type: "reasoning", status: "completed" } }),
                sse("response.output_item.added", { output_index: 1, item: { id: "item_2", type: "message", content: [] } }),
                sse("response.content_part.added", { item_id: "item_2", output_index: 1, part: { type: "output_text", text: "" } }),
                sse("response.output_text.delta", { item_id: "item_2", output_index: 1, delta: "recovered after the nudge" }),
                sse("response.output_text.done", { item_id: "item_2", output_index: 1, text: "recovered after the nudge" }),
                sse("response.output_item.done", { output_index: 1, item: { id: "item_2", type: "message", content: [{ type: "output_text", text: "recovered after the nudge" }] } }),
                sse("response.completed", { response: { id: "resp_2", status: "completed", output: [] } }),
            ]),
        );
    };
    const attempt1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { output_index: 0, item: { id: "item_1", type: "message", content: [] } }),
        sse("response.content_part.added", { item_id: "item_1", output_index: 0, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { item_id: "item_1", output_index: 0, delta: `${TAG_OPEN}m00155${TAG_CLOSE}` }),
        sse("response.output_text.done", { item_id: "item_1", output_index: 0, text: `${TAG_OPEN}m00155${TAG_CLOSE}` }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(attempt1), makeRes(out), makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 1, "the echo-only turn is still retried");
    // The retry's reasoning item was never announced to the client (its added
    // is dropped), so its part/delta/done frames must be suppressed rather than
    // handed over with an id the client cannot resolve.
    assert.ok(!text.includes("rs_9"), `no retry reasoning id may leak, got: ${text}`);
    assert.ok(!text.includes("retry thinking"), "the unannounced reasoning text is suppressed, not mis-attributed");
    assert.ok(text.includes("recovered after the nudge"), "the retry's message content still lands");
});
