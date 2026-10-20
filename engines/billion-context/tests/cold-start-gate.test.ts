import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { loadOptions, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";

interface Harness {
    proxyPort: number;
    upstreamPort: number;
    bodies: Array<Record<string, unknown>>;
    close(): Promise<void>;
}

function anthropicJson(): string {
    return JSON.stringify({
        id: "msg_gate",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
    });
}

async function startHarness(compress: { injectTool: boolean; injectNudge: boolean; injectAfterTokens?: number }): Promise<Harness> {
    const bodies: Array<Record<string, unknown>> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            try {
                bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            } catch {
                bodies.push({});
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(anthropicJson());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        promptCache: { routing: "auto" },
        compress,
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
    const proxyPort = (proxy.address() as AddressInfo).port;
    return {
        proxyPort,
        upstreamPort,
        bodies,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

function systemText(body: Record<string, unknown>): string {
    const system = body.system;
    if (typeof system === "string") return system;
    if (Array.isArray(system)) {
        return system
            .map((block) => (block && typeof block === "object" ? String((block as { text?: unknown }).text ?? "") : ""))
            .join("\n");
    }
    return "";
}

function toolNames(body: Record<string, unknown>): string[] {
    const tools = body.tools;
    if (!Array.isArray(tools)) return [];
    return tools.map((tool) => {
        const record = tool && typeof tool === "object" ? (tool as Record<string, unknown>) : {};
        if (typeof record.name === "string") return record.name;
        const fn = record.function;
        if (fn && typeof fn === "object" && typeof (fn as { name?: unknown }).name === "string") {
            return (fn as { name: string }).name;
        }
        return "";
    });
}

async function post(harness: Harness, session: string, text: string): Promise<void> {
    const resp = await fetch(
        `http://127.0.0.1:${harness.proxyPort}/bili/http://127.0.0.1:${harness.upstreamPort}/v1/messages`,
        {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": session },
            body: JSON.stringify({
                model: "claude-test",
                max_tokens: 1024,
                stream: false,
                system: "You are a test assistant.",
                messages: [{ role: "user", content: text }],
            }),
        },
    );
    assert.equal(resp.status, 200);
    await resp.text();
}

test("ACP_INJECT_AFTER_TOKENS is parsed into the proxy options", () => {
    const withThreshold = loadOptions({ ACP_INJECT_AFTER_TOKENS: "32000" } as NodeJS.ProcessEnv);
    assert.equal(withThreshold.compress.injectAfterTokens, 32000);
    const withoutThreshold = loadOptions({} as NodeJS.ProcessEnv);
    assert.equal(withoutThreshold.compress.injectAfterTokens, 0);
    const garbage = loadOptions({ ACP_INJECT_AFTER_TOKENS: "not-a-number" } as NodeJS.ProcessEnv);
    assert.equal(garbage.compress.injectAfterTokens, 0);
});

test("cold-start gate keeps the injection surface off below the threshold", async () => {
    const h = await startHarness({ injectTool: true, injectNudge: true, injectAfterTokens: 5_000 });
    try {
        await post(h, "gate-cold", "hello there");
        assert.equal(h.bodies.length, 1);
        const body = h.bodies[0]!;
        assert.equal(toolNames(body).includes("compress"), false, "compress tool must not be declared below the threshold");
        assert.equal(systemText(body), "You are a test assistant.", "system must stay byte-identical below the threshold");
    } finally {
        await h.close();
    }
});

test("cold-start gate opens on the first request that crosses the threshold and stays open", async () => {
    const h = await startHarness({ injectTool: true, injectNudge: true, injectAfterTokens: 5_000 });
    try {
        const big = "lorem ipsum dolor sit amet ".repeat(2_000);
        await post(h, "gate-warm", big);
        assert.equal(h.bodies.length, 1);
        const opened = h.bodies[0]!;
        assert.equal(toolNames(opened).includes("compress"), true, "compress tool must be declared once the gate opens");
        assert.ok(systemText(opened).length > "You are a test assistant.".length, "compress prompt must reach the system block");

        await post(h, "gate-warm", "hello again");
        assert.equal(h.bodies.length, 2);
        const latched = h.bodies[1]!;
        assert.equal(toolNames(latched).includes("compress"), true, "the gate must latch open for the rest of the session");
    } finally {
        await h.close();
    }
});

test("a zero threshold injects from the very first request", async () => {
    const h = await startHarness({ injectTool: true, injectNudge: true, injectAfterTokens: 0 });
    try {
        await post(h, "gate-open", "hello there");
        const body = h.bodies[0]!;
        assert.equal(toolNames(body).includes("compress"), true, "a zero threshold must not gate anything");
    } finally {
        await h.close();
    }
});

test("the session ledger records the injection overhead it actually added", async () => {
    const h = await startHarness({ injectTool: true, injectNudge: true, injectAfterTokens: 0 });
    try {
        await post(h, "overhead-session", "hello there");
        const session = getSession("overhead-session");
        assert.ok((session.stats.injectedOverheadTokens ?? 0) > 0, "the injected prompt/tool cost must be measured, not guessed");
    } finally {
        await h.close();
    }
});

test("a gated session adds no injection overhead at all", async () => {
    const h = await startHarness({ injectTool: true, injectNudge: true, injectAfterTokens: 5_000 });
    try {
        await post(h, "overhead-cold-session", "hello there");
        const session = getSession("overhead-cold-session");
        assert.equal(session.stats.injectedOverheadTokens ?? 0, 0, "nothing was injected, so nothing may be charged");
    } finally {
        await h.close();
    }
});
