import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { fetchWithTimeout, _resetFetchUtilForTest, _liveUpstreamTimersForTest } from "../src/fetch-util.ts";

function listen(server: http.Server): Promise<void> {
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("stopIdleTimer drops the idle watchdog but keeps client-abort alive (#1064 #15)", async () => {
    // Regression guard for #1064 #15: stopIdleTimer must clear the idle
    // watchdog WITHOUT detaching the client-abort listener. splice/continue
    // callers (degenerate-retry, reasoning-guard) drop the timer yet still rely
    // on downstream disconnect to cancel a stalled upstream; if stopping the
    // timer also removed the abort listener, such a stream would have neither
    // watchdog nor abort (unbounded upstream billing). Asserts both halves by
    // event ordering (no wall-clock timers).
    const timeoutMs = 5_000;
    _resetFetchUtilForTest();
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        res.write("chunk-1\n");
        // never ends — simulates a stalled upstream
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    try {
        const ac = new AbortController();
        const result = await fetchWithTimeout(`http://127.0.0.1:${port}/stuck`, {}, timeoutMs, ac.signal);
        assert.equal(_liveUpstreamTimersForTest(), 1, "one idle watchdog armed for the in-flight request");
        const reader = (result.response.body as ReadableStream<Uint8Array>).getReader();
        const first = await reader.read();
        assert.ok(first.value && first.value.length > 0, "first chunk arrives before the stall");
        let name = "";
        const pendingRead = reader.read().catch((e: unknown) => {
            name = e instanceof Error ? e.name : String(e);
            return { done: true };
        });
        result.stopIdleTimer();
        assert.equal(_liveUpstreamTimersForTest(), 0, "stopIdleTimer removes the idle watchdog");
        ac.abort();
        await pendingRead;
        assert.equal(name, "AbortError", "client abort must still propagate after stopIdleTimer (#1064 #15)");
        reader.releaseLock();
    } finally {
        upstream.closeAllConnections();
        await close(upstream);
    }
});

test("clearTimer detaches the client-abort listener (full cleanup)", async () => {
    // Contrast to the case above: clearTimer is the full cleanup used once a
    // response is fully consumed/discarded, and it MUST remove the abort
    // listener as well as the timer. A bounded window asserts the abort does
    // NOT reach the stream (absence), without depending on a stall to surface.
    const timeoutMs = 5_000;
    _resetFetchUtilForTest();
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        res.write("chunk-1\n");
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    try {
        const ac = new AbortController();
        const result = await fetchWithTimeout(`http://127.0.0.1:${port}/stuck`, {}, timeoutMs, ac.signal);
        const reader = (result.response.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        let propagated = false;
        const pendingRead = reader.read().catch(() => {
            propagated = true;
            return { done: true };
        });
        result.clearTimer();
        ac.abort();
        await Promise.race([pendingRead, new Promise((r) => setTimeout(r, 200))]);
        assert.equal(propagated, false, "clearTimer must detach the client-abort listener");
        reader.releaseLock();
    } finally {
        upstream.closeAllConnections();
        await close(upstream);
    }
});
