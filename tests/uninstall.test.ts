import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planUninstall, runUninstall, stripCodexBlock } from "@hypercontext/runtime";

const OUR_HOOK = {
  matcher: ".*",
  hooks: [{ type: "command", command: '"node" "hook-wrapper.ts" --home /tmp/x claude-code pretooluse.mjs' }],
};
const OUR_STOP = { hooks: [{ type: "command", command: "node /repo/engines/context-mode/hooks/stop.mjs" }] };
const USER_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: "node keep-me.mjs" }] };

const CODEX_TOML = [
  'model = "gpt-5"',
  "",
  "[mcp_servers.other]",
  'command = "keep"',
  "",
  "[mcp_servers.hypercontext]",
  'command = "node"',
  'args = ["bin/hctx.mjs", "mcp"]',
  "",
  "[features]",
  "fork = true",
  "",
].join("\n");

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "hctx-uninstall-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".hypercontext", "state", "clients", "claude-code"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify(
      { model: "opus", hooks: { PreToolUse: [USER_HOOK, OUR_HOOK], Stop: [OUR_STOP] } },
      null,
      2,
    ),
  );
  writeFileSync(join(home, ".codex", "config.toml"), CODEX_TOML);
  writeFileSync(join(home, ".hypercontext", "config.json"), "{}");
  writeFileSync(join(home, ".hypercontext", "state", "clients", "claude-code", "mcp.json"), "{}");
  return home;
}

test("uninstall removes only hypercontext entries and keeps user config", async () => {
  const home = makeHome();
  try {
    const plan = await planUninstall({ userHome: home, env: {} });
    const ids = plan.actions.map((action) => action.id);
    assert.ok(ids.includes("hooks:Claude Code"), "claude hooks should be planned");
    assert.ok(ids.includes("codex"), "codex block should be planned");
    assert.ok(ids.includes("del:state"), "state dir should be planned for deletion");

    const result = await runUninstall(plan, { env: {} });
    assert.deepEqual(result.errors, []);

    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")) as {
      model: string;
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.model, "opus");
    assert.deepEqual(settings.hooks.PreToolUse, [USER_HOOK]);
    assert.equal(settings.hooks.Stop, undefined, "events left empty are dropped");
    assert.ok(existsSync(join(home, ".claude", "settings.json.hypercontext-uninstall.bak")), "backup written");

    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
    assert.ok(!toml.includes("mcp_servers.hypercontext"));
    assert.ok(toml.includes("[mcp_servers.other]"));
    assert.ok(toml.includes("[features]"));

    assert.equal(existsSync(join(home, ".hypercontext")), false, "unified state deleted");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--keep-data rolls back configs but preserves unified state", async () => {
  const home = makeHome();
  try {
    const plan = await planUninstall({ userHome: home, env: {}, keepData: true });
    assert.ok(!plan.actions.some((action) => action.id === "del:state"));
    const result = await runUninstall(plan, { env: {}, keepData: true });
    assert.deepEqual(result.errors, []);
    assert.ok(existsSync(join(home, ".hypercontext", "config.json")));
    assert.ok(!readFileSync(join(home, ".claude", "settings.json"), "utf-8").includes("hook-wrapper"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dry run touches nothing", async () => {
  const home = makeHome();
  try {
    const plan = await planUninstall({ userHome: home, env: {} });
    const result = await runUninstall(plan, { env: {}, dryRun: true });
    assert.deepEqual(result.done, []);
    assert.ok(existsSync(join(home, ".hypercontext", "config.json")));
    assert.ok(readFileSync(join(home, ".claude", "settings.json"), "utf-8").includes("hook-wrapper"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a clean machine plans no restores", async () => {
  const home = mkdtempSync(join(tmpdir(), "hctx-uninstall-clean-"));
  try {
    const plan = await planUninstall({ userHome: home, env: {} });
    assert.ok(!plan.actions.some((action) => action.kind === "restore"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("stripCodexBlock drops the block and its keys only", () => {
  const stripped = stripCodexBlock(CODEX_TOML);
  assert.equal(stripped.removed, 1);
  assert.ok(!stripped.text.includes("hypercontext"));
  assert.ok(stripped.text.includes('model = "gpt-5"'));
  assert.ok(stripped.text.includes('command = "keep"'));
  assert.ok(stripped.text.includes("fork = true"));
});
