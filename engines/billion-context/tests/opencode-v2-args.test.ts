import assert from "node:assert";
import test from "node:test";

process.env.NODE_ENV = "test";

import { opencodeV2Args } from "../src/launcher.ts";

/** OpenCode v2 moved the one-shot flags under `opencode run`; the root command
 *  rejects --model/--session/--print and any positional message. A v1-era
 *  command line therefore breaks on the v2 binary the desktop app ships. */
test("opencode v1 command lines are passed through unchanged", () => {
  const args = ["--model", "opencode/some-model", "hello"];
  assert.deepEqual(opencodeV2Args("opencode", args, 1), args);
});

test("opencode v2 moves model/message invocations under `run`", () => {
  assert.deepEqual(
    opencodeV2Args("opencode", ["--model", "opencode/some-model", "hello"], 2),
    ["run", "--model", "opencode/some-model", "hello"],
  );
  assert.deepEqual(opencodeV2Args("opencode", ["hello"], 2), ["run", "hello"]);
  assert.deepEqual(opencodeV2Args("opencode", ["--session", "ses_x"], 2), ["run", "--session", "ses_x"]);
  assert.deepEqual(opencodeV2Args("opencode", ["--print"], 2), ["run", "--print"]);
});

test("a bare v2 TUI launch keeps its root command", () => {
  assert.deepEqual(opencodeV2Args("opencode", [], 2), []);
  assert.deepEqual(opencodeV2Args("opencode", ["--help"], 2), ["--help"]);
});
