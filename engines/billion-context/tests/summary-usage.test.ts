import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

process.env.NODE_ENV = "test";

import { configuredSummaryPlan } from "../src/external-summary-runtime.ts";
import { recordSummaryUsage } from "../src/session.ts";
import { getSession } from "../src/session.ts";

interface Usage {
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    ok: boolean;
}

async function startSummaryServer(status: number): Promise<{ port: number; close(): Promise<void> }> {
    const server = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(status, { "content-type": "application/json" });
            if (status === 200) {
                res.end(JSON.stringify({
                    id: "cmpl-gate",
                    object: "chat.completion",
                    choices: [{ index: 0, message: { role: "assistant", content: "SUMMARY OF THE WORK" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
                }));
                return;
            }
            res.end(JSON.stringify({ error: { message: "boom" } }));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    return {
        port,
        close: async () => {
            server.close();
            server.closeIdleConnections?.();
            await once(server, "close");
        },
    };
}

function chain(port: number): unknown {
    return {
        enabled: true,
        targets: [
            {
                name: "local",
                protocol: "openai",
                url: `http://127.0.0.1:${port}/v1/chat/completions`,
                model: "local-summary",
                apiKey: "test-key",
                contextWindow: 32_000,
                outputTokens: 1024,
                stream: false,
            },
        ],
        budget: { totalTimeoutMs: 5_000, targetTimeoutMs: 5_000, maxSummaryBytes: 65_536 },
    };
}

test("a summary call reports its token estimate and its real latency", async () => {
    const server = await startSummaryServer(200);
    try {
        const captured: Usage[] = [];
        const plan = configuredSummaryPlan(chain(server.port), undefined, (usage) => captured.push(usage));
        assert.ok(plan);
        const batch = await plan.summarize([{ content: "a long conversation", instructions: "summarize" }]);
        assert.equal(batch.results.length, 1);
        assert.equal(batch.results[0]?.status, "success");
        assert.equal(captured.length, 1);
        const usage = captured[0]!;
        assert.equal(usage.ok, true);
        assert.ok(usage.inputTokens > 0, "the summary input must be estimated");
        assert.ok(usage.outputTokens > 0, "the summary output must be estimated");
        assert.ok(usage.durationMs >= 0);
        assert.equal(plan.usage.calls, 1);
        assert.equal(plan.usage.inputTokens, usage.inputTokens);
        assert.equal(plan.usage.outputTokens, usage.outputTokens);
    } finally {
        await server.close();
    }
});

test("a failed summary call is still accounted as an attempted call", async () => {
    const server = await startSummaryServer(500);
    try {
        const captured: Usage[] = [];
        const plan = configuredSummaryPlan(chain(server.port), undefined, (usage) => captured.push(usage));
        assert.ok(plan);
        await plan.summarize([{ content: "a long conversation", instructions: "summarize" }]);
        assert.equal(captured.length, 1);
        assert.equal(captured[0]!.ok, false);
        assert.equal(plan.usage.calls, 1);
        assert.equal(plan.usage.failures, 1);
    } finally {
        await server.close();
    }
});

test("summary usage lands in the session ledger", () => {
    const session = getSession("summary-usage-ledger");
    recordSummaryUsage(session, { inputTokens: 1_000, outputTokens: 120, durationMs: 250, ok: true });
    recordSummaryUsage(session, { inputTokens: 500, outputTokens: 60, durationMs: 100, ok: false });
    assert.equal(session.stats.summaryCalls, 2);
    assert.equal(session.stats.summaryInputTokens, 1_500);
    assert.equal(session.stats.summaryOutputTokens, 180);
    assert.equal(session.stats.summaryLatencyMs, 350);
});
