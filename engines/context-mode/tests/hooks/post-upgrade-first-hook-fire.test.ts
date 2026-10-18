/**
 * post-upgrade-first-hook-fire — regression test for the Windows + Git Bash
 * first-hook-fire window after /ctx-upgrade (#414 + #528).
 *
 * Why this exists (#711 + #414 split):
 *
 *   PR #713 fixed #711 by removing `normalizeHooksOnStartup` from
 *   `src/cli.ts upgrade()`. That call originally served TWO goals (13d1342 /
 *   #528):
 *     (a) Stop tmpdir paths from leaking into hooks.json / plugin.json.
 *     (b) Close the Windows + Git Bash first-hook-fire gap (#414) — Claude
 *         Code fires SessionStart / PreToolUse BEFORE the MCP server boots,
 *         so the unresolved `${CLAUDE_PLUGIN_ROOT}` placeholder in
 *         `hooks/hooks.json` yields MODULE_NOT_FOUND for the first hook
 *         fire after upgrade until start.mjs boots and rewrites it.
 *
 *   Removing the call entirely re-opened (b). The narrow
 *   `normalizeHooksJsonOnly` helper preserves (b) without re-introducing
 *   #711: it touches `hooks/hooks.json` only, leaving `plugin.json` in its
 *   portable `${CLAUDE_PLUGIN_ROOT}` form so Claude Code's auto-update can
 *   copy it forward into a new versioned cache dir without baking stale
 *   absolute paths.
 *
 * This file asserts the contract:
 *   1. `normalizeHooksJsonOnly` rewrites hooks.json on Windows / Linux.
 *   2. `normalizeHooksJsonOnly` leaves plugin.json UNTOUCHED (the #711
 *      invariant — narrow scope is the whole point).
 *   3. macOS is a no-op (system node resolves bare `node`).
 *   4. Cross-process first-hook-fire: a freshly normalized hooks.json
 *      contains an absolute, parseable command that a child Node process
 *      can resolve without MODULE_NOT_FOUND, even without MCP boot.
 */

import { describe, test, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  normalizeHooksJsonOnly,
  normalizeHooksOnStartup,
} from "../../hooks/normalize-hooks.mjs";

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) {
    const dir = cleanups.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
});

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctx-711-414-"));
  cleanups.push(dir);
  return dir;
}

function seedFixture(dir: string): {
  hooksPath: string;
  pluginJsonPath: string;
  hooksOriginal: string;
  pluginJsonOriginal: string;
} {
  mkdirSync(join(dir, "hooks"), { recursive: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  // Also seed start.mjs so child-process resolution can succeed.
  writeFileSync(join(dir, "start.mjs"), "// stub\n");

  const hooksPath = join(dir, "hooks", "hooks.json");
  const hooksOriginal = JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command:
                  'node "${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.mjs"',
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  );
  writeFileSync(hooksPath, hooksOriginal);

  const pluginJsonPath = join(dir, ".claude-plugin", "plugin.json");
  const pluginJsonOriginal = JSON.stringify(
    {
      name: "context-mode",
      version: "1.0.149",
      mcpServers: {
        "context-mode": {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"],
        },
      },
    },
    null,
    2,
  );
  writeFileSync(pluginJsonPath, pluginJsonOriginal);

  return { hooksPath, pluginJsonPath, hooksOriginal, pluginJsonOriginal };
}

describe("normalizeHooksJsonOnly (the upgrade-time narrow helper)", () => {
  test("rewrites hooks.json on Windows (closes #414 first-hook-fire gap)", () => {
    const dir = makeTmp();
    const { hooksPath, hooksOriginal } = seedFixture(dir);

    normalizeHooksJsonOnly({
      pluginRoot: dir,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    const after = readFileSync(hooksPath, "utf-8");
    expect(after).not.toBe(hooksOriginal);
    expect(after).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(after).toContain("C:/Program Files/nodejs/node.exe");
  });

  test("rewrites hooks.json on Linux (bare node not in /bin/sh PATH)", () => {
    const dir = makeTmp();
    const { hooksPath, hooksOriginal } = seedFixture(dir);

    normalizeHooksJsonOnly({
      pluginRoot: dir,
      nodePath: "/home/user/.nvm/versions/node/v22.0.0/bin/node",
      platform: "linux",
    });

    const after = readFileSync(hooksPath, "utf-8");
    expect(after).not.toBe(hooksOriginal);
    expect(after).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(after).toContain("/home/user/.nvm/versions/node/v22.0.0/bin/node");
  });

  test("no-op on macOS (system node resolves bare `node`)", () => {
    const dir = makeTmp();
    const { hooksPath, hooksOriginal } = seedFixture(dir);

    normalizeHooksJsonOnly({
      pluginRoot: dir,
      nodePath: "/usr/local/bin/node",
      platform: "darwin",
    });

    expect(readFileSync(hooksPath, "utf-8")).toBe(hooksOriginal);
  });

  test("#711 invariant — leaves plugin.json UNTOUCHED on Windows", () => {
    // The whole point of the narrow helper. plugin.json must keep the
    // ${CLAUDE_PLUGIN_ROOT} placeholder so Claude Code's plugin-manager
    // auto-update can carry it forward into a new versioned cache dir
    // without baking a stale absolute path.
    const dir = makeTmp();
    const { pluginJsonPath, pluginJsonOriginal } = seedFixture(dir);

    normalizeHooksJsonOnly({
      pluginRoot: dir,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    const after = readFileSync(pluginJsonPath, "utf-8");
    expect(after).toBe(pluginJsonOriginal);
    expect(after).toContain("${CLAUDE_PLUGIN_ROOT}/start.mjs");
  });

  test("idempotent — second call leaves a normalized hooks.json unchanged", () => {
    const dir = makeTmp();
    const { hooksPath } = seedFixture(dir);

    normalizeHooksJsonOnly({
      pluginRoot: dir,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });
    const firstPass = readFileSync(hooksPath, "utf-8");

    normalizeHooksJsonOnly({
      pluginRoot: dir,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });
    const secondPass = readFileSync(hooksPath, "utf-8");

    expect(secondPass).toBe(firstPass);
  });

  test("does not throw when hooks.json is missing", () => {
    const dir = makeTmp();
    // No seed — pluginRoot/hooks/hooks.json does not exist
    expect(() =>
      normalizeHooksJsonOnly({
        pluginRoot: dir,
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        platform: "win32",
      }),
    ).not.toThrow();
  });

  test("guards: no-op when pluginRoot or nodePath missing", () => {
    const dir = makeTmp();
    const { hooksPath, hooksOriginal } = seedFixture(dir);

    normalizeHooksJsonOnly({
      pluginRoot: "",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });
    expect(readFileSync(hooksPath, "utf-8")).toBe(hooksOriginal);

    normalizeHooksJsonOnly({
      pluginRoot: dir,
      nodePath: "",
      platform: "win32",
    });
    expect(readFileSync(hooksPath, "utf-8")).toBe(hooksOriginal);
  });
});

describe("normalizeHooksOnStartup still normalizes both (boot-time contract)", () => {
  test("boot-time helper rewrites BOTH hooks.json and plugin.json", () => {
    // Regression guard: extracting normalizeHooksJsonOnly must NOT shrink
    // start.mjs / postinstall's contract — they still need both files
    // normalized so the live MCP boot resolves placeholders correctly.
    const dir = makeTmp();
    const { hooksPath, pluginJsonPath, hooksOriginal, pluginJsonOriginal } =
      seedFixture(dir);

    normalizeHooksOnStartup({
      pluginRoot: dir,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    const hooksAfter = readFileSync(hooksPath, "utf-8");
    const pluginAfter = readFileSync(pluginJsonPath, "utf-8");

    expect(hooksAfter).not.toBe(hooksOriginal);
    expect(hooksAfter).not.toContain("${CLAUDE_PLUGIN_ROOT}");

    expect(pluginAfter).not.toBe(pluginJsonOriginal);
    expect(pluginAfter).not.toContain("${CLAUDE_PLUGIN_ROOT}");
  });
});

describe("cross-process first-hook-fire after upgrade (#414)", () => {
  test("normalized hooks.json yields a parseable absolute command a child process can resolve", () => {
    // Simulates: /ctx-upgrade just ran → hooks.json was normalized → Claude
    // Code fires SessionStart in a child process BEFORE MCP boot. The
    // command must resolve to an existing absolute path without
    // MODULE_NOT_FOUND.
    const dir = makeTmp();
    const { hooksPath } = seedFixture(dir);
    // The seeded hooks.json references hooks/sessionstart.mjs — create
    // the file so the resolved command points at something that exists.
    writeFileSync(join(dir, "hooks", "sessionstart.mjs"), "// stub\n");

    normalizeHooksJsonOnly({
      pluginRoot: dir,
      nodePath: process.execPath,
      platform: process.platform === "win32" ? "win32" : "linux",
    });

    const parsed = JSON.parse(readFileSync(hooksPath, "utf-8"));
    const cmd: string =
      parsed.hooks.SessionStart[0].hooks[0].command as string;

    // The normalized command must NOT carry the placeholder and MUST
    // reference an absolute filesystem path (forward-slash form on
    // Windows is intentional — see #372).
    expect(cmd).not.toContain("${CLAUDE_PLUGIN_ROOT}");

    // Extract the script argument (`"…/hooks/sessionstart.mjs"`) and
    // assert the file exists on disk — the contract Claude Code's hook
    // dispatcher relies on for the first fire after upgrade.
    const match = cmd.match(/"([^"]+sessionstart\.mjs)"/);
    expect(match).not.toBeNull();
    const scriptPath = match![1];

    // Use a child `node -e require(...)` to mirror what Claude Code's
    // hook runner does — fails with MODULE_NOT_FOUND if the path is
    // unresolvable. On Windows the absolute path uses forward slashes
    // which Node accepts on every platform.
    const res = spawnSync(
      process.execPath,
      [
        "-e",
        `require('fs').accessSync(${JSON.stringify(scriptPath)}); console.log('ok')`,
      ],
      { encoding: "utf-8" },
    );
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("ok");
    expect(res.stderr).not.toContain("MODULE_NOT_FOUND");
  });
});
