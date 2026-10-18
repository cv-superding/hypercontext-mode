// #2028: web-configurable dsh native compaction switch (allowDshCompaction).
// Pins: (a) config resolution matrix (file / env / default), (b) the web API
// GET/PUT contract incl. the env-forced 409, (c) the end-to-end behavior flip —
// the #1729 wire guard refuses dsh compaction envelopes by default, forwards
// them once the switch is flipped ON through the LIVE web API (hot reload),
// and refuses again once cleared.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { allowDshCompactionState, loadOptions, type ProxyOptions } from "../src/config.ts";
import { DSH_COMPACTION_INSTRUCTION_PREFIX, dshCompactionRefusal } from "../src/server/dsh-compaction-guard.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

/** Point BILI_CONFIG_FILE at a temp file (or a missing path when body is
 *  null) for the duration of fn, restoring the previous value afterwards. */
function withConfig(body: string | null, fn: () => void): void {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-issue2028-"));
    const file = path.join(dir, "billion-context.json");
    if (body !== null) writeFileSync(file, body, "utf8");
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = file;
    try {
        fn();
    } finally {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prev;
        rmrf(dir);
    }
}

function envWith(value: string | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    if (value !== undefined) env.BILI_ALLOW_DSH_COMPACTION = value;
    return env;
}

test("#2028: allowDshCompaction resolution — file, env, default OFF", () => {
    withConfig(null, () => assert.equal(loadOptions(envWith(undefined)).allowDshCompaction, false, "default OFF (#1729 behavior unchanged)"));
    withConfig('{"dsh":{"allowDshCompaction":true}}', () => assert.equal(loadOptions(envWith(undefined)).allowDshCompaction, true, "file enables (nested dsh.* section)"));
withConfig('{"allowDshCompaction":true}', () => assert.equal(loadOptions(envWith(undefined)).allowDshCompaction, true, "legacy top-level location still enables (auto-relocated)"));
    withConfig('{"dsh":{"allowDshCompaction":true}}', () => assert.equal(loadOptions(envWith("0")).allowDshCompaction, false, "env 0 beats file"));
    withConfig(null, () => assert.equal(loadOptions(envWith("1")).allowDshCompaction, true, "env 1 enables"));
    withConfig(null, () => assert.equal(loadOptions(envWith("yes")).allowDshCompaction, true, "non-\"0\" env values enable (house BILI_ boolean semantics)"));
});

test("#2028: allowDshCompactionState source resolution", () => {
    withConfig(null, () => assert.deepEqual(allowDshCompactionState(envWith(undefined)), { enabled: false, source: null }));
    withConfig('{"dsh":{"allowDshCompaction":true}}', () => assert.deepEqual(allowDshCompactionState(envWith(undefined)), { enabled: true, source: "file" }));
withConfig('{"allowDshCompaction":true}', () => assert.deepEqual(allowDshCompactionState(envWith(undefined)), { enabled: true, source: "file" }));
    withConfig('{"dsh":{"allowDshCompaction":true}}', () => assert.deepEqual(allowDshCompactionState(envWith("0")), { enabled: false, source: "env" }));
    withConfig(null, () => assert.deepEqual(allowDshCompactionState(envWith("1")), { enabled: true, source: "env" }));
});

test("#2028: refusal message points at the real opt-in (stale preset reference removed)", () => {
    const body = dshCompactionRefusal("openai").body as { error: { message: string } };
    assert.ok(!body.error.message.includes("standard-bili-auto-off"), "stale preset reference must be gone");
    assert.ok(body.error.message.includes("allowDshCompaction") && body.error.message.includes("BILI_ALLOW_DSH_COMPACTION"), body.error.message);
});

// ---------------------------------------------------------------------------
// Integration: real bili server + real mock upstream, live hot-reload flip.

function closeServer(server: http.Server): Promise<void> {
    server.closeAllConnections?.();
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function post(port: number, reqPath: string, payload: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    const data = JSON.stringify(payload);
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = http.request({
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)), ...headers },
    }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end(data);
    return promise;
}

/** PUT variant — the web config API is PUT /__bili/config (POST 404s). */
function put(port: number, reqPath: string, payload: unknown): Promise<{ status: number; body: string }> {
    const data = JSON.stringify(payload);
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = http.request({
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "PUT",
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) },
    }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end(data);
    return promise;
}

async function get(port: number, reqPath: string): Promise<{ status: number; body: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = http.request({ host: "127.0.0.1", port, path: reqPath }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString("utf8"); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end();
    return promise;
}

test("#2028: the web toggle flips the #1729 wire guard live (refuse -> forward -> refuse)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-2028-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const cfgFile = path.join(root, "billion-context.json");
    writeFileSync(cfgFile, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = cfgFile;

    const received: string[] = [];
    const mock = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            received.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl_2028", object: "chat.completion", created: 1, model: "mock",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
    mock.listen(0, "127.0.0.1");
    await once(mock, "listening");
    const mockPort = (mock.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${mockPort}`,
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const bili = await startServer(opts);
    await once(bili, "listening");
    const port = (bili.address() as { port: number }).port;

    const compactionPost = (): Promise<{ status: number; body: string }> => post(port, "/v1/chat/completions", {
        model: "mock",
        messages: [
            { role: "system", content: "sys" },
            { role: "user", content: `${DSH_COMPACTION_INSTRUCTION_PREFIX} Summarize the conversation above.` },
        ],
    }, { "x-acp-session": "s-2028" });
    const cfgJson = async (): Promise<Record<string, unknown>> => JSON.parse((await get(port, "/__bili/config")).body);

    try {
        // A: default — exposed state + wire refusal, nothing reaches upstream.
        assert.deepEqual(await cfgJson().then((c) => c.allowDshCompaction), { enabled: false, source: null });
        let r = await compactionPost();
        assert.equal(r.status, 422, `default must refuse (got ${r.status}: ${r.body})`);
        assert.equal(JSON.parse(r.body).error.code, "dsh_compaction_refused");
        assert.equal(received.length, 0, "refused call never reaches the upstream");

        // B: enable through the live web API → hot-forward, byte-exact envelope.
        r = await put(port, "/__bili/config", { dsh: { allowDshCompaction: true } });
        assert.equal(r.status, 200, r.body);
        assert.equal(JSON.parse(readFileSync(cfgFile, "utf8")).dsh.allowDshCompaction, true, "file gained the key under dsh.*");
        assert.deepEqual((await cfgJson()).allowDshCompaction, { enabled: true, source: "file" });
        r = await compactionPost();
        assert.equal(r.status, 200, `allowed call must be forwarded (got ${r.status}: ${r.body})`);
        assert.equal(received.length, 1, "forwarded to the upstream");
        assert.ok(received[0].includes(DSH_COMPACTION_INSTRUCTION_PREFIX), "envelope forwarded byte-exact");

        // C: clear (null) → key removed, guard active again.
        r = await put(port, "/__bili/config", { dsh: { allowDshCompaction: null } });
        assert.equal(r.status, 200, r.body);
        const clearedFile = JSON.parse(readFileSync(cfgFile, "utf8"));
        assert.ok(!clearedFile.dsh || !("allowDshCompaction" in clearedFile.dsh), "key cleared from the file");
        assert.deepEqual((await cfgJson()).allowDshCompaction, { enabled: false, source: null });
        r = await compactionPost();
        assert.equal(r.status, 422, "guard restored after clear");
        assert.equal(received.length, 1, "still refused after clear");

        // D: validation errors.
        r = await put(port, "/__bili/config", { dsh: { allowDshCompaction: "yes" } });
        assert.equal(r.status, 400);
        assert.match(r.body, /must be a boolean or null/);
        r = await put(port, "/__bili/config", {});
        assert.equal(r.status, 400);
        assert.match(r.body, /dsh compaction settings/);

        // E: whole-file save honors the same field.
        r = await put(port, "/__bili/config", { file: JSON.stringify({ providers: {}, dsh: { allowDshCompaction: true } }) });
        assert.equal(r.status, 200, r.body);
        assert.equal(JSON.parse(readFileSync(cfgFile, "utf8")).dsh.allowDshCompaction, true);
        r = await put(port, "/__bili/config", { file: JSON.stringify({ providers: {}, allowDshCompaction: true }) });
        assert.equal(r.status, 200, r.body);
        const relocatedFile = JSON.parse(readFileSync(cfgFile, "utf8"));
        assert.equal(relocatedFile.dsh.allowDshCompaction, true, "legacy top-level key relocated into dsh.* on save");
        assert.ok(!("allowDshCompaction" in relocatedFile), "top-level position no longer present");
        r = await put(port, "/__bili/config", { file: JSON.stringify({ providers: {} }) });
        assert.equal(r.status, 200, r.body);
        assert.ok(!("allowDshCompaction" in JSON.parse(readFileSync(cfgFile, "utf8"))));

        // F: env-forced contradiction → 409 (mirrors the #405 passthrough contract).
        process.env.BILI_ALLOW_DSH_COMPACTION = "0";
        try {
            r = await put(port, "/__bili/config", { dsh: { allowDshCompaction: true } });
            assert.equal(r.status, 409, r.body);
            assert.match(r.body, /BILI_ALLOW_DSH_COMPACTION/);
            r = await put(port, "/__bili/config", { dsh: { allowDshCompaction: false } });
            assert.equal(r.status, 200, "matching write allowed");
            r = await put(port, "/__bili/config", { dsh: { allowDshCompaction: null } });
            assert.equal(r.status, 200, "clear allowed under env force");
            r = await put(port, "/__bili/config", { file: JSON.stringify({ dsh: { allowDshCompaction: true } }) });
            assert.equal(r.status, 409, "whole-file contradiction refused");
            process.env.BILI_ALLOW_DSH_COMPACTION = "1";
            r = await put(port, "/__bili/config", { dsh: { allowDshCompaction: false } });
            assert.equal(r.status, 409, "env=1 forces allow; writing false contradicts");
            r = await put(port, "/__bili/config", { dsh: { allowDshCompaction: true } });
            assert.equal(r.status, 200, "matching write allowed");
        } finally {
            delete process.env.BILI_ALLOW_DSH_COMPACTION;
        }
    } finally {
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevConfig;
        await closeServer(bili);
        await closeServer(mock);
        rmrf(root);
    }
});
