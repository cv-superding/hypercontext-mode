import assert from "node:assert";
import test from "node:test";
import { createInitialState } from "acp-kernel";
import { buildStatusPanel } from "acp-kernel/panel";
import { CACHE_REPORT_CLOSE, CACHE_REPORT_OPEN, RULE_REPORT_CLOSE, RULE_REPORT_OPEN, isAcpPanelText, stripAcpPanelMessages, stripAcpPanelResponsesInput, wrapCacheReport, wrapRuleReport } from "../src/acp-panel.ts";

// Generate the REAL panel the proxy produces (handlePluginStatus →
// buildStatusPanel), so the signature test tracks acp-kernel's actual output
// rather than a hand-typed copy that could drift.
function realPanel(): string {
    return buildStatusPanel({
        version: "billion-context@0.1.64",
        tokenCount: 100000,
        systemPromptTokens: 0,
        state: createInitialState(),
        nudge: undefined,
        modelContextLimit: 200000,
    });
}

const FALLBACK = "📊 ACP status\n  context: 12.3K / 200.0K (6.2%)\n  requests: 7";

test("isAcpPanelText detects the buildStatusPanel box", () => {
    const panel = realPanel();
    assert.ok(panel.startsWith("\u256d"), "sanity: box starts with the top border");
    assert.equal(isAcpPanelText(panel), true);
});

test("isAcpPanelText detects the renderAcpStatus fallback header", () => {
    assert.equal(isAcpPanelText(FALLBACK), true);
});

test("isAcpPanelText tolerates surrounding whitespace", () => {
    assert.equal(isAcpPanelText(`\n  ${realPanel()}  \n`), true);
});

test("isAcpPanelText rejects normal user content", () => {
    assert.equal(isAcpPanelText("hello world"), false);
    assert.equal(isAcpPanelText(""), false);
    assert.equal(isAcpPanelText("   "), false);
});

test("isAcpPanelText rejects a message that merely quotes the panel", () => {
    const panel = realPanel();
    assert.equal(isAcpPanelText(`here is the panel:\n${panel}`), false, "quoted panel is a real user message");
    assert.equal(isAcpPanelText('I saw "ACP Context Analysis" today'), false, "title alone is not a panel");
});

test("isAcpPanelText rejects a panel with a follow-up appended (suffix case)", () => {
    const panel = realPanel();
    assert.equal(isAcpPanelText(`${panel}\n\nmy follow-up question`), false, "panel + follow-up is a real user message");
    assert.equal(isAcpPanelText(`${panel} and what about X?`), false, "panel + inline follow-up preserved");
    assert.equal(isAcpPanelText(`${FALLBACK}\nmy follow-up question`), false, "fallback + follow-up is a real user message");
});

test("isAcpPanelText tolerates surrounding whitespace on the fallback", () => {
    assert.equal(isAcpPanelText(`\n  ${FALLBACK}  \n`), true);
});

test("stripAcpPanelMessages removes panel user messages (string + block content)", () => {
    const panel = realPanel();
    const messages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: panel },
        { role: "user", content: [{ type: "text", text: FALLBACK }] },
        { role: "assistant", content: [{ type: "text", text: panel }] },
        { role: "user", content: "next question" },
    ];
    const stripped = stripAcpPanelMessages(messages);
    assert.equal(stripped, 2, "two panel user messages removed");
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "assistant", "user"]);
});

test("stripAcpPanelMessages preserves multimodal and non-user content", () => {
    const panel = realPanel();
    const messages = [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", data: "x" } }] },
        { role: "user", content: [{ type: "tool_result", content: panel }] },
        { role: "assistant", content: panel },
    ];
    const stripped = stripAcpPanelMessages(messages);
    assert.equal(stripped, 0, "no plain-text panel user message here");
    assert.equal(messages.length, 3);
});

test("stripAcpPanelMessages is a no-op on non-array input", () => {
    assert.equal(stripAcpPanelMessages("not an array"), 0);
    assert.equal(stripAcpPanelMessages(undefined), 0);
});

test("stripAcpPanelResponsesInput removes panel user items, keeps others", () => {
    const panel = realPanel();
    const input = [
        { type: "message", role: "user", content: "hi" },
        { type: "message", role: "assistant", content: "hello" },
        { type: "message", role: "user", content: panel },
        { type: "function_call", name: "compress", arguments: "{}", id: "fc1" },
        { type: "message", role: "user", content: [{ type: "input_text", text: FALLBACK }] },
        { role: "user", content: panel },
    ];
    const stripped = stripAcpPanelResponsesInput(input);
    assert.equal(stripped, 3, "three panel user items removed (typed + type-less)");
    assert.deepEqual(input.map((i) => i.type ?? "message"), ["message", "message", "function_call"]);
});

test("stripAcpPanelResponsesInput is a no-op on string input and non-arrays", () => {
    assert.equal(stripAcpPanelResponsesInput(realPanel()), 0);
    assert.equal(stripAcpPanelResponsesInput(undefined), 0);
});

// #800: /acp-cache persists the kernel cache report via wrapCacheReport. The
// report shape is kernel-owned (variable-length LINE ITEMS table), so only the
// plugin's own wrapper marks it as strippable — an unwrapped report (e.g. one
// the model produced via the acp_cache tool, or user-typed) must survive.
const REPORT = [
    "ACP CACHE REPORT (sess-x) \u2014 3 requests",
    "",
    "GRAND LEDGER   input=90K  cached=60K  hit rate 66.7%  (of non-system input 30K)",
    "  new content         25K   27.8%",
    "  compression re-pay   5K   5.6%",
    "  TTL expiry           0K   0.0%",
    "  identity check   OK \u2014 30K = 25K + 5K + 0K (residual 0)",
].join("\n");

test("isAcpPanelText detects the wrapped cache report (#800)", () => {
    assert.equal(isAcpPanelText(wrapCacheReport(REPORT)), true);
});

test("isAcpPanelText rejects an unwrapped cache report (only the plugin's wrapper is stripped)", () => {
    assert.equal(isAcpPanelText(REPORT), false);
});

test("isAcpPanelText rejects a wrapped report with a follow-up appended (suffix case)", () => {
    assert.equal(isAcpPanelText(`${wrapCacheReport(REPORT)}\nmy follow-up question`), false, "report + follow-up is a real user message");
    assert.equal(isAcpPanelText(`${wrapCacheReport(REPORT)} and what about X?`), false, "report + inline follow-up preserved");
});

test("isAcpPanelText tolerates surrounding whitespace on the wrapped report", () => {
    assert.equal(isAcpPanelText(`\n  ${wrapCacheReport(REPORT)}  \n`), true);
});

test("isAcpPanelText rejects a message that merely quotes the wrapper markers", () => {
    assert.equal(isAcpPanelText(`here is my custom block:\n${CACHE_REPORT_OPEN}\nsome text\n${CACHE_REPORT_CLOSE}\nafter`), false, "markers inside a longer message are not a report");
});

test("stripAcpPanelMessages removes wrapped-report user messages (string + block content)", () => {
    const messages = [
        { role: "user", content: "hi" },
        { role: "user", content: wrapCacheReport(REPORT) },
        { role: "user", content: [{ type: "text", text: wrapCacheReport(REPORT) }] },
        { role: "assistant", content: wrapCacheReport(REPORT) },
        { role: "user", content: "next question" },
    ];
    const stripped = stripAcpPanelMessages(messages);
    assert.equal(stripped, 2, "two wrapped-report user messages removed");
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
});

test("stripAcpPanelResponsesInput removes wrapped-report user items, keeps others", () => {
    const input = [
        { type: "message", role: "user", content: "hi" },
        { type: "message", role: "user", content: wrapCacheReport(REPORT) },
        { role: "user", content: [{ type: "input_text", text: wrapCacheReport(REPORT) }] },
        { type: "function_call", name: "compress", arguments: "{}", id: "fc1" },
    ];
    const stripped = stripAcpPanelResponsesInput(input);
    assert.equal(stripped, 2, "two wrapped-report user items removed (typed + type-less)");
    assert.deepEqual(input.map((i) => i.type ?? "message"), ["message", "function_call"]);
});

// #1251: /acp-rule persists the executeRule output via wrapRuleReport — same
// marker contract as wrapCacheReport: only plugin-wrapped messages are stripped.
const RULES = [
    "Recorded rules:",
    "rule1: always run npm test before committing",
].join("\n");

test("isAcpPanelText detects the wrapped rule report (#1251)", () => {
    assert.equal(isAcpPanelText(wrapRuleReport(RULES)), true);
});

test("isAcpPanelText rejects an unwrapped rule report (only the plugin's wrapper is stripped)", () => {
    assert.equal(isAcpPanelText(RULES), false);
});

test("isAcpPanelText rejects a wrapped rule report with a follow-up appended (suffix case)", () => {
    assert.equal(isAcpPanelText(`${wrapRuleReport(RULES)}\nmy follow-up question`), false, "report + follow-up is a real user message");
    assert.equal(isAcpPanelText(`${wrapRuleReport(RULES)} and what about X?`), false, "report + inline follow-up preserved");
});

test("isAcpPanelText tolerates surrounding whitespace on the wrapped rule report", () => {
    assert.equal(isAcpPanelText(`\n  ${wrapRuleReport(RULES)}  \n`), true);
});

test("isAcpPanelText rejects a message that merely quotes the rule wrapper markers", () => {
    assert.equal(isAcpPanelText(`here is my custom block:\n${RULE_REPORT_OPEN}\nsome text\n${RULE_REPORT_CLOSE}\nafter`), false, "markers inside a longer message are not a report");
});

test("stripAcpPanelMessages removes wrapped rule-report user messages (string + block content)", () => {
    const messages = [
        { role: "user", content: "hi" },
        { role: "user", content: wrapRuleReport(RULES) },
        { role: "user", content: [{ type: "text", text: wrapRuleReport(RULES) }] },
        { role: "assistant", content: wrapRuleReport(RULES) },
        { role: "user", content: "next question" },
    ];
    const stripped = stripAcpPanelMessages(messages);
    assert.equal(stripped, 2, "two wrapped rule-report user messages removed");
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
});

test("stripAcpPanelResponsesInput removes wrapped rule-report user items, keeps others", () => {
    const input = [
        { type: "message", role: "user", content: "hi" },
        { type: "message", role: "user", content: wrapRuleReport(RULES) },
        { role: "user", content: [{ type: "input_text", text: wrapRuleReport(RULES) }] },
        { type: "function_call", name: "acp_rule", arguments: "{}", id: "fc1" },
    ];
    const stripped = stripAcpPanelResponsesInput(input);
    assert.equal(stripped, 2, "two wrapped rule-report user items removed (typed + type-less)");
    assert.deepEqual(input.map((i) => i.type ?? "message"), ["message", "function_call"]);
});
