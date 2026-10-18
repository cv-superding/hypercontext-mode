import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_OUTPUT_STEERING,
    applyOutputSteering,
    applyOutputSteeringJson,
    parseOutputSteering,
    resolveVerbosityLevel,
    steeringText,
    type OutputSteeringConfig,
} from "../src/output-steering.ts";

const SENTINEL = "<bili_output_steering>";
const SUFFIX = "</bili_output_steering>";

const ON: OutputSteeringConfig = { enabled: true, verbosityLevel: 2, effortRouting: true };
const STEER_ONLY: OutputSteeringConfig = { enabled: true, verbosityLevel: 2, effortRouting: false };
const EFFORT_ONLY: OutputSteeringConfig = { enabled: true, verbosityLevel: 0, effortRouting: true };

test("parseOutputSteering: non-object falls back to undefined (caller substitutes default)", () => {
    assert.equal(parseOutputSteering(undefined), undefined);
    assert.equal(parseOutputSteering(null), undefined);
    assert.equal(parseOutputSteering("on"), undefined);
    assert.equal(parseOutputSteering([]), undefined);
});

test("parseOutputSteering: defaults and clamping", () => {
    assert.deepEqual(parseOutputSteering({}), { enabled: false, verbosityLevel: 2, effortRouting: true });
    assert.deepEqual(parseOutputSteering({ enabled: true }), { enabled: true, verbosityLevel: 2, effortRouting: true });
    assert.equal(parseOutputSteering({ enabled: true, verbosityLevel: 0 })?.verbosityLevel, 0);
    assert.equal(parseOutputSteering({ enabled: true, verbosityLevel: 4 })?.verbosityLevel, 4);
    assert.equal(parseOutputSteering({ enabled: true, verbosityLevel: 9 })?.verbosityLevel, 2);
    assert.equal(parseOutputSteering({ enabled: true, verbosityLevel: -1 })?.verbosityLevel, 2);
    assert.equal(parseOutputSteering({ enabled: true, verbosityLevel: 2.5 })?.verbosityLevel, 2);
    assert.equal(parseOutputSteering({ enabled: "yes" })?.enabled, false);
    assert.deepEqual(parseOutputSteering({ enabled: true, effortRouting: false }), { enabled: true, verbosityLevel: 2, effortRouting: false });
});

test("DEFAULT_OUTPUT_STEERING is off by default", () => {
    assert.equal(DEFAULT_OUTPUT_STEERING.enabled, false);
});

test("steeringText: L0 is none, L1-L4 are sentinel-wrapped and distinct", () => {
    assert.equal(steeringText(0), null);
    assert.equal(steeringText(5), null);
    for (const lvl of [1, 2, 3, 4]) {
        const t = steeringText(lvl)!;
        assert.ok(t.startsWith(`${SENTINEL}\n`), `L${lvl} opens with sentinel`);
        assert.ok(t.endsWith(SUFFIX), `L${lvl} closes with suffix`);
    }
    assert.notEqual(steeringText(2), steeringText(3));
});

test("anthropic: appends to a string system prompt at the tail", () => {
    const out = applyOutputSteering(JSON.stringify({ model: "m", system: "You are terse.", messages: [{ role: "user", content: "hi" }] }), "anthropic", STEER_ONLY);
    assert.equal(out.changed, true);
    assert.deepEqual(out.labels, ["steering:L2"]);
    assert.ok((JSON.parse(out.body).system as string).endsWith(SUFFIX));
});

test("anthropic: appends AFTER an array system, preserving cache_control breakpoints", () => {
    const body = { model: "m", system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "hi" }] };
    const out = applyOutputSteering(JSON.stringify(body), "anthropic", STEER_ONLY);
    const sys = JSON.parse(out.body).system as Array<Record<string, unknown>>;
    assert.equal(sys.length, 2);
    assert.deepEqual(sys[0].cache_control, { type: "ephemeral" }, "earlier breakpoint untouched");
    assert.ok(String(sys[1].text).startsWith(SENTINEL), "directive appended after the last block");
});

test("openai: appends to the last system OR developer message content", () => {
    for (const role of ["system", "developer"]) {
        const out = applyOutputSteering(JSON.stringify({ model: "m", messages: [{ role, content: "sys" }, { role: "user", content: "hi" }] }), "openai", STEER_ONLY);
        assert.equal(out.changed, true, `${role} targeted`);
        assert.ok((JSON.parse(out.body).messages[0].content as string).endsWith(SUFFIX));
    }
});

test("responses: appends to the instructions string", () => {
    const out = applyOutputSteering(JSON.stringify({ model: "m", instructions: "base", input: [{ type: "message", role: "user", content: "hi" }] }), "responses", STEER_ONLY);
    assert.equal(out.changed, true);
    assert.ok((JSON.parse(out.body).instructions as string).endsWith(SUFFIX));
});

test("google: appends a part to systemInstruction.parts", () => {
    const body = { model: "m", systemInstruction: { parts: [{ text: "base" }] }, contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    const out = applyOutputSteering(JSON.stringify(body), "google", STEER_ONLY);
    const parts = (JSON.parse(out.body).systemInstruction as { parts: Array<{ text: string }> }).parts;
    assert.equal(parts.length, 2);
    assert.ok(parts[1].text.startsWith(SENTINEL));
});

test("skip-if-absent: no system carrier means no fabrication, byte-identical", () => {
    const cases: Array<[string, string]> = [
        ["anthropic", JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] })],
        ["openai", JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] })],
        ["responses", JSON.stringify({ model: "m", input: [{ type: "message", role: "user", content: "hi" }] })],
        ["google", JSON.stringify({ model: "m", contents: [{ role: "user", parts: [{ text: "hi" }] }] })],
    ];
    for (const [proto, s] of cases) {
        const out = applyOutputSteering(s, proto as "anthropic", STEER_ONLY);
        assert.equal(out.changed, false, `${proto}: nothing to attach to`);
        assert.equal(out.body, s, `${proto}: byte-identical`);
        assert.deepEqual(out.labels, []);
    }
});

test("idempotent: same-level re-apply is a byte-stable no-op", () => {
    const base = JSON.stringify({ model: "m", instructions: "You are terse." });
    const first = applyOutputSteering(base, "responses", ON);
    assert.equal(first.changed, true);
    assert.deepEqual(first.labels, ["steering:L2"]);

    const second = applyOutputSteering(first.body, "responses", ON);
    assert.equal(second.changed, false, "re-applying the same level must not mutate");
    assert.equal(second.body, first.body, "...and must be byte-identical");
    assert.deepEqual(second.labels, []);
});

test("idempotent: a level change REPLACES the block in place (no duplication)", () => {
    const first = applyOutputSteering(JSON.stringify({ model: "m", instructions: "You are terse." }), "responses", ON);
    const third = applyOutputSteering(first.body, "responses", { ...ON, verbosityLevel: 3 });
    assert.equal(third.changed, true);
    const ins = JSON.parse(third.body).instructions as string;
    assert.equal(ins.split(SENTINEL).length - 1, 1, "exactly one steering block after a level change");
    assert.notEqual(third.body, first.body);
});

test("anthropic: mechanical continuation lowers effort + clamps thinking budget", () => {
    const body = {
        model: "m",
        system: "b",
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }],
        output_config: { effort: "xhigh" },
        thinking: { type: "enabled", budget_tokens: 16000 },
    };
    const out = applyOutputSteering(JSON.stringify(body), "anthropic", EFFORT_ONLY);
    assert.equal(out.changed, true);
    assert.deepEqual(out.labels, ["effort:low"]);
    const p = JSON.parse(out.body);
    assert.equal(p.output_config.effort, "low");
    assert.equal(p.thinking.budget_tokens, 1024, "budget clamped to API floor");
});

test("anthropic: error continuation leaves effort untouched", () => {
    const body = {
        model: "m",
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }] }],
        output_config: { effort: "xhigh" },
    };
    const out = applyOutputSteering(JSON.stringify(body), "anthropic", EFFORT_ONLY);
    assert.equal(out.changed, false);
    assert.deepEqual(out.labels, []);
    assert.equal(JSON.parse(out.body).output_config.effort, "xhigh");
});

test("anthropic: never injects effort fields the client did not send", () => {
    const s = JSON.stringify({ model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] }] });
    const out = applyOutputSteering(s, "anthropic", EFFORT_ONLY);
    assert.equal(out.changed, false);
    assert.equal(out.body, s);
    assert.ok(!("output_config" in JSON.parse(out.body)), "no fabricated output_config");
    assert.ok(!("thinking" in JSON.parse(out.body)), "no fabricated thinking");
});

test("openai: trailing tool message lowers reasoning_effort; a real user turn does not", () => {
    const mech = { model: "m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "result" }], reasoning_effort: "high" };
    const outM = applyOutputSteering(JSON.stringify(mech), "openai", EFFORT_ONLY);
    assert.deepEqual(outM.labels, ["effort:low"]);
    assert.equal(JSON.parse(outM.body).reasoning_effort, "low");

    const ask = { model: "m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "" }, { role: "user", content: "next" }], reasoning_effort: "high" };
    const outA = applyOutputSteering(JSON.stringify(ask), "openai", EFFORT_ONLY);
    assert.equal(outA.changed, false);
    assert.equal(JSON.parse(outA.body).reasoning_effort, "high", "non-mechanical turn untouched");

    const noField = { model: "m", messages: [{ role: "tool", tool_call_id: "c", content: "r" }] };
    assert.equal(applyOutputSteering(JSON.stringify(noField), "openai", EFFORT_ONLY).changed, false, "no injection when reasoning_effort absent");
});

test("responses: tool-output-only input lowers reasoning.effort; a user signal does not", () => {
    const mech = { model: "m", input: [{ type: "function_call_output", call_id: "c", output: "{}" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }], reasoning: { effort: "high" } };
    const outM = applyOutputSteering(JSON.stringify(mech), "responses", EFFORT_ONLY);
    assert.deepEqual(outM.labels, ["effort:low"]);
    assert.equal((JSON.parse(outM.body).reasoning as { effort: string }).effort, "low");

    const ask = { model: "m", input: [{ role: "user", content: [{ type: "input_text", text: "do X" }] }], reasoning: { effort: "high" } };
    const outA = applyOutputSteering(JSON.stringify(ask), "responses", EFFORT_ONLY);
    assert.equal(outA.changed, false);
    assert.equal((JSON.parse(outA.body).reasoning as { effort: string }).effort, "high");
});

test("google: functionResponse-only turn clamps thinkingBudget; dynamic (-1) and text turns untouched", () => {
    const mech = { model: "m", contents: [{ role: "user", parts: [{ functionResponse: { name: "f", response: {} } }] }], generationConfig: { thinkingConfig: { thinkingBudget: 8000 } } };
    const outM = applyOutputSteering(JSON.stringify(mech), "google", EFFORT_ONLY);
    assert.deepEqual(outM.labels, ["effort:low"]);
    assert.equal((JSON.parse(outM.body).generationConfig.thinkingConfig as { thinkingBudget: number }).thinkingBudget, 128);

    const dyn = { model: "m", contents: [{ role: "user", parts: [{ functionResponse: { name: "f", response: {} } }] }], generationConfig: { thinkingConfig: { thinkingBudget: -1 } } };
    assert.equal(applyOutputSteering(JSON.stringify(dyn), "google", EFFORT_ONLY).changed, false, "dynamic budget left alone");

    const ask = { model: "m", contents: [{ role: "user", parts: [{ text: "hello" }] }], generationConfig: { thinkingConfig: { thinkingBudget: 8000 } } };
    assert.equal(applyOutputSteering(JSON.stringify(ask), "google", EFFORT_ONLY).changed, false, "a real user turn is not mechanical");
});

test("both levers fire on a steerable mechanical turn, labels ordered steering-then-effort", () => {
    const body = {
        model: "m",
        system: "b",
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] }],
        output_config: { effort: "high" },
    };
    const out = applyOutputSteering(JSON.stringify(body), "anthropic", ON);
    assert.deepEqual(out.labels, ["steering:L2", "effort:low"]);
    assert.equal(JSON.parse(out.body).output_config.effort, "low");
});

test("default (disabled) is byte-transparent for every wire", () => {
    const s = JSON.stringify({ model: "m", instructions: "x", input: [], reasoning: { effort: "high" } });
    const out = applyOutputSteering(s, "responses", DEFAULT_OUTPUT_STEERING);
    assert.equal(out.body, s);
    assert.equal(out.changed, false);
    assert.deepEqual(out.labels, []);
});

test("null protocol: inferred from body shape", () => {
    const responses = applyOutputSteering(JSON.stringify({ model: "m", instructions: "b", input: [{ type: "message", role: "user", content: "h" }] }), null, STEER_ONLY);
    assert.equal(responses.changed, true, "input[] → responses");

    const anthropic = applyOutputSteering(JSON.stringify({ model: "m", system: "b", messages: [{ role: "user", content: "h" }] }), null, STEER_ONLY);
    assert.equal(anthropic.changed, true, "top-level system → anthropic");

    const openai = applyOutputSteering(JSON.stringify({ model: "m", messages: [{ role: "system", content: "b" }, { role: "user", content: "h" }] }), null, STEER_ONLY);
    assert.equal(openai.changed, true, "messages without top-level system → openai");

    const google = applyOutputSteering(JSON.stringify({ model: "m", systemInstruction: { parts: [{ text: "b" }] }, contents: [{ role: "user", parts: [{ text: "h" }] }] }), null, STEER_ONLY);
    assert.equal(google.changed, true, "contents[] → google");

    const unknown = applyOutputSteering(JSON.stringify({ model: "m" }), null, STEER_ONLY);
    assert.equal(unknown.changed, false, "unrecognizable shape → no-op");
});

test("invalid JSON is returned verbatim", () => {
    const out = applyOutputSteering("not json", "openai", ON);
    assert.equal(out.body, "not json");
    assert.equal(out.changed, false);
});

test("applyOutputSteeringJson mutates in place and is idempotent", () => {
    const obj = { model: "m", instructions: "base" } as Record<string, unknown>;
    assert.deepEqual(applyOutputSteeringJson(obj, "responses", STEER_ONLY), ["steering:L2"]);
    assert.deepEqual(applyOutputSteeringJson(obj, "responses", STEER_ONLY), [], "second pass finds the block already present");
    assert.ok(String(obj.instructions).includes(SENTINEL));
});

test("responses: full-history re-send (original ask + call + output) IS a mechanical continuation", () => {
    const body = {
        model: "m",
        instructions: "You are Codex.",
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug in src/a.ts" }] },
            { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}', call_id: "call_1" },
            { type: "function_call_output", call_id: "call_1", output: "file listing" },
        ],
        reasoning: { effort: "high" },
    };
    const out = applyOutputSteering(JSON.stringify(body), "responses", EFFORT_ONLY);
    assert.deepEqual(out.labels, ["effort:low"]);
    assert.equal((JSON.parse(out.body).reasoning as { effort: string }).effort, "low");
});

test("responses: codex custom_tool_call / apply_patch shapes stay mechanical", () => {
    const body = {
        model: "m",
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "run the tests" }] },
            { type: "custom_tool_call", name: "shell", input: '{"cmd":"npm test"}', call_id: "c1" },
            { type: "custom_tool_call_output", call_id: "c1", output: "all pass" },
            { type: "apply_patch_call", input: "*** Begin Patch\n*** End Patch", call_id: "c2" },
            { type: "apply_patch_call_output", call_id: "c2", output: "Success." },
        ],
        reasoning: { effort: "medium" },
    };
    const out = applyOutputSteering(JSON.stringify(body), "responses", EFFORT_ONLY);
    assert.deepEqual(out.labels, ["effort:low"]);
});

test("responses: a fresh user signal at the tail blocks lowering even after outputs", () => {
    const body = {
        model: "m",
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "do X" }] },
            { type: "function_call", name: "f", arguments: "{}", call_id: "c1" },
            { type: "function_call_output", call_id: "c1", output: "ok" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "now do Y" }] },
        ],
        reasoning: { effort: "high" },
    };
    assert.equal(applyOutputSteering(JSON.stringify(body), "responses", EFFORT_ONLY).changed, false);
});

test("responses: a pending call with no output yet is not a continuation", () => {
    const body = {
        model: "m",
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "do X" }] },
            { type: "function_call", name: "f", arguments: "{}", call_id: "c1" },
        ],
        reasoning: { effort: "high" },
    };
    assert.equal(applyOutputSteering(JSON.stringify(body), "responses", EFFORT_ONLY).changed, false);
});

test("anthropic: unrecognized block composition is not classified mechanical", () => {
    const body = {
        model: "m",
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }, { type: "mystery_block" }] }],
        output_config: { effort: "high" },
    };
    assert.equal(applyOutputSteering(JSON.stringify(body), "anthropic", EFFORT_ONLY).changed, false);
});

test("google: unrecognized part composition is not classified mechanical", () => {
    const body = {
        model: "m",
        contents: [{ role: "user", parts: [{ functionResponse: { name: "f", response: {} } }, { mystery: true }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 8000 } },
    };
    assert.equal(applyOutputSteering(JSON.stringify(body), "google", EFFORT_ONLY).changed, false);
});

test("openai: explicit minimal effort is never raised to low", () => {
    const mech = { model: "m", messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "result" }], reasoning_effort: "minimal" };
    const out = applyOutputSteering(JSON.stringify(mech), "openai", EFFORT_ONLY);
    assert.equal(out.changed, false, "minimal sits below the low floor — clamp must not raise it");
    assert.equal(JSON.parse(out.body).reasoning_effort, "minimal");
});

test("responses: explicit minimal effort is never raised to low", () => {
    const mech = { model: "m", input: [{ type: "function_call_output", call_id: "c", output: "{}" }], reasoning: { effort: "minimal" } };
    const out = applyOutputSteering(JSON.stringify(mech), "responses", EFFORT_ONLY);
    assert.equal(out.changed, false, "minimal sits below the low floor — clamp must not raise it");
    assert.equal((JSON.parse(out.body).reasoning as { effort: string }).effort, "minimal");
});

test("applyOutputSteeringJson opts.verbosity=false skips the directive but keeps effort routing", () => {
    const obj = { model: "m", messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "result" }], reasoning_effort: "high" };
    const labels = applyOutputSteeringJson(obj, "openai", { enabled: true, verbosityLevel: 2, effortRouting: true }, { verbosity: false });
    assert.deepEqual(labels, ["effort:low"]);
    assert.equal(obj.reasoning_effort, "low");
    const sys = obj.messages.find((m) => m.role === "system" || m.role === "developer");
    assert.equal(sys, undefined, "no steering block appended on compress rounds");
});

test("resolveVerbosityLevel: omitted field takes default WITHOUT warning", () => {
    assert.deepEqual(resolveVerbosityLevel(undefined), { level: DEFAULT_OUTPUT_STEERING.verbosityLevel });
});

test("resolveVerbosityLevel: valid levels 0-4 pass through untouched", () => {
    for (const n of [0, 1, 2, 3, 4]) assert.deepEqual(resolveVerbosityLevel(n), { level: n });
});

test("resolveVerbosityLevel: present-but-invalid values warn and fall back", () => {
    for (const bad of [9, -1, 2.5, "high", null]) {
        const r = resolveVerbosityLevel(bad);
        assert.equal(r.level, DEFAULT_OUTPUT_STEERING.verbosityLevel);
        assert.ok(r.warning?.includes("must be an integer 0-4"), `expected warning for ${JSON.stringify(bad)}, got ${r.warning}`);
    }
});
