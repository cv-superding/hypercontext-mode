// #1158: some dsh profile-install sessions show ZERO model requests reaching
// the proxy (root cause under investigation with runtime evidence — transport
// fetch shape vs host-side attribution gap), yet the model keeps calling the
// registered bili tools. The 404 for such a conversation must be actionable —
// hypothesis-neutral (no single confirmed cause named), preserving the
// substrings mcp.ts / opencode-v2.ts match on — and the warn one-shot per
// conversation, not a silent repeat or an unselfable generic 404.
import assert from "node:assert/strict";
import http from "node:http";
import { beforeEach, describe, it } from "node:test";

import { createCore, defaultConfig } from "acp-kernel";
import { type PluginToolDeps, _resetPluginStateForTest, handlePluginTool, recordPluginSession } from "../src/plugin.ts";

function mockRes(): { res: http.ServerResponse; status(): number; body(): string } {
    let body = "";
    let status = 0;
    const res = {
        writeHead: (code: number) => {
            status = code;
            return undefined;
        },
        end: (chunk: unknown) => {
            body = String(chunk ?? "");
        },
    } as unknown as http.ServerResponse;
    return { res, status: () => status, body: () => body };
}

describe("#1158: no-model-request 404 is loud, actionable, and one-shot", () => {
    let logs: string[];
    let deps: PluginToolDeps;

    beforeEach(() => {
        _resetPluginStateForTest();
        logs = [];
        deps = { core: createCore(), config: defaultConfig(400_000), log: (level, msg) => { logs.push(`${level}: ${msg}`); } };
    });

    async function call(conversationId: string, tool = "acp_status"): Promise<{ status: number; json: { ok: boolean; error?: string } }> {
        const out = mockRes();
        await handlePluginTool(JSON.stringify({ conversationId, tool, args: {} }), out.res, deps);
        return { status: out.status(), json: JSON.parse(out.body()) as { ok: boolean; error?: string } };
    }

    it("unknown conversation 404 keeps the consumer substrings and gains actionable guidance", async () => {
        const r = await call("bypass-conv");
        assert.equal(r.status, 404);
        assert.equal(r.json.ok, false);
        // Consumers that must keep matching: src/mcp.ts ORPHAN_ADOPT and
        // src/agent/opencode-v2.ts stale-id recovery.
        assert.match(r.json.error ?? "", /no model request has arrived with this conversation id yet/);
        assert.match(r.json.error ?? "", /no model request has arrived/);
        // The actionable part: names the candidate causes + how to verify.
        assert.match(r.json.error ?? "", /bypass/i);
        assert.match(r.json.error ?? "", /attribution/);
        assert.match(r.json.error ?? "", /processTurn/);
        const warns = logs.filter((l) => l.includes("NO MODEL REQUESTS"));
        assert.equal(warns.length, 1, `expected exactly one NO MODEL REQUESTS warn, got: ${logs.join(" | ")}`);
        assert.match(warns[0]!, /warn: \[plugin\] NO MODEL REQUESTS seen for conversation bypass-conv \(tool "acp_status"\)/);
        assert.match(warns[0]!, /bypasses the intercepted fetch/);
        assert.match(warns[0]!, /stale after a host resume/);
        assert.match(warns[0]!, /launcher/);
        // The wording must NOT name any single confirmed cause (#1158 retraction).
        assert.doesNotMatch(warns[0]!, /known case/i);
    });

    it("the warn fires once per conversation, not per rejected tool call", async () => {
        await call("bypass-conv");
        await call("bypass-conv", "compress");
        await call("bypass-conv", "decompress");
        const warns = logs.filter((l) => l.includes("NO MODEL REQUESTS"));
        assert.equal(warns.length, 1, `one-shot violated: ${logs.join(" | ")}`);
    });

    it("a different conversation gets its own one-shot warning", async () => {
        await call("bypass-conv-a");
        await call("bypass-conv-b");
        const warns = logs.filter((l) => l.includes("NO MODEL REQUESTS"));
        assert.equal(warns.length, 2);
        assert.match(warns[0]!, /bypass-conv-a/);
        assert.match(warns[1]!, /bypass-conv-b/);
    });

    it("_resetPluginStateForTest clears the one-shot set so a fresh boot warns again", async () => {
        await call("stale-after-reset");
        _resetPluginStateForTest();
        logs = [];
        await call("stale-after-reset");
        const warns = logs.filter((l) => l.includes("NO MODEL REQUESTS"));
        assert.equal(warns.length, 1);
    });

    it("a registered-but-non-resident id keeps the legacy per-call warn and error wording", async () => {
        recordPluginSession("stale-entry", "session-gone-from-store");
        const r1 = await call("stale-entry");
        assert.equal(r1.status, 404);
        assert.match(r1.json.error ?? "", /id registered but its session is not resident in this proxy instance/);
        await call("stale-entry", "compress");
        assert.equal(logs.filter((l) => l.includes("NO MODEL REQUESTS")).length, 0, "entry-exists path must not use the bypass wording");
        assert.equal(logs.filter((l) => l.includes("id registered but session not resident")).length, 2, "legacy per-call warn unchanged");
    });
});
