/**
 * normalize-hooks.mjs bun rewrite — issue #738.
 *
 * The static `hooks/hooks.json` ships with bare `node ...` commands.
 * `normalizeHooksOnStartup` rewrites them at MCP boot to absolute paths.
 * When bun is available, the rewrite should use bun instead of node.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

describe("normalizeHooksOnStartup — bun-aware rewrite (#738)", () => {
  let pluginRoot: string;
  let hooksPath: string;

  beforeEach(() => {
    pluginRoot = mkdtempSync(join(tmpdir(), "ctx-norm-bun-"));
    mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
    hooksPath = join(pluginRoot, "hooks", "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.mjs"',
                },
              ],
            },
          ],
        },
      }, null, 2),
    );
  });

  afterEach(() => {
    try { rmSync(pluginRoot, { recursive: true, force: true }); } catch {}
  });

  function readEmittedPreToolUseCommand(): string {
    const parsed = JSON.parse(readFileSync(hooksPath, "utf-8"));
    return parsed.hooks.PreToolUse[0].hooks[0].command;
  }

  test("uses jsRuntimePath when provided (bun)", async () => {
    const { normalizeHooksOnStartup } = await import("../../hooks/normalize-hooks.mjs");
    normalizeHooksOnStartup({
      pluginRoot,
      nodePath: "/usr/local/bin/node",
      jsRuntimePath: "/usr/local/bin/bun",
      platform: "linux",
    });
    const cmd = readEmittedPreToolUseCommand();
    expect(cmd).toContain('"/usr/local/bin/bun"');
    expect(cmd.startsWith("node ")).toBe(false);
  });

  test("falls back to nodePath when jsRuntimePath omitted (back-compat)", async () => {
    const { normalizeHooksOnStartup } = await import("../../hooks/normalize-hooks.mjs");
    normalizeHooksOnStartup({
      pluginRoot,
      nodePath: "/usr/local/bin/node",
      platform: "linux",
    });
    const cmd = readEmittedPreToolUseCommand();
    expect(cmd).toContain('"/usr/local/bin/node"');
  });

  test("macOS bun rewrite path triggers when jsRuntimePath provided (issue context)", async () => {
    // Issue #738 was filed from macOS — confirm rewrite fires on darwin too
    // when an explicit jsRuntimePath is passed. Pre-fix the macOS branch was
    // gated by `platform !== "win32" && platform !== "linux"` returning early.
    const { normalizeHooksOnStartup } = await import("../../hooks/normalize-hooks.mjs");
    normalizeHooksOnStartup({
      pluginRoot,
      nodePath: "/usr/local/bin/node",
      jsRuntimePath: "/opt/homebrew/bin/bun",
      platform: "darwin",
    });
    const cmd = readEmittedPreToolUseCommand();
    expect(cmd).toContain('"/opt/homebrew/bin/bun"');
  });
});

describe("normalizeHooksJson — bun rewrite content-level (#738)", () => {
  test("rewrites node prefix to provided jsRuntimePath", async () => {
    const { normalizeHooksJson } = await import("../../hooks/normalize-hooks.mjs");
    const content = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs"' }],
          },
        ],
      },
    });
    const out = normalizeHooksJson(content, "/usr/local/bin/bun", "/plugin");
    const parsed = JSON.parse(out);
    const emittedCmd = parsed.hooks.PreToolUse[0].hooks[0].command;
    expect(emittedCmd).toContain('"/usr/local/bin/bun"');
    expect(emittedCmd).toContain("/plugin/hooks/x.mjs");
    expect(emittedCmd.startsWith("node ")).toBe(false);
  });

  test("output remains valid JSON", async () => {
    const { normalizeHooksJson } = await import("../../hooks/normalize-hooks.mjs");
    const content = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs"' }],
          },
        ],
      },
    });
    const out = normalizeHooksJson(content, "/usr/local/bin/bun", "/plugin");
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
