/**
 * start.mjs boot-time fetch-dep install MUST NOT EPERM on Windows — closes #861.
 *
 * The background install of the three optional fetch deps (turndown,
 * turndown-plugin-gfm, @mixmark-io/domino) spawned npm with `shell: IS_WIN32`.
 * On Windows + Node, `shell: true` DROPS the `cwd` option: the spawned cmd.exe
 * runs in an arbitrary working dir (C:\Windows under Claude Code), so
 * `npm install` tries to create `C:\Windows\node_modules` → EPERM on EVERY MCP
 * boot, and a cmd.exe window flashes each time. Because the install never
 * persists, the existsSync guard never short-circuits and it re-fires forever
 * (reported by @lravizzoni with npm-debug-log evidence; @ken-jo to verify on
 * Windows).
 *
 * Fix: prefer invoking npm's own CLI through node directly (no `.cmd` shim, no
 * shell) — `shell: false` honors `cwd`, `windowsHide` suppresses the console
 * window — and fall back to the shim only when npm-cli.js can't be located, so
 * a working host can never regress.
 *
 * SEAM NOTE: start.mjs is a side-effecting raw entry script (can't import). The
 * structural assertions below match the established start.mjs pattern
 * (start-mjs-mcp-boot.test.ts, #634). The behavioral test pins the actual
 * runtime property the fix depends on — `shell:false` honors `cwd` — which is
 * portable (it holds on every OS; the BUG is that `shell:true` violates it on
 * Windows only).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(__dirname, "..", "..");
const START_MJS = readFileSync(resolve(REPO_ROOT, "start.mjs"), "utf8");

/** Remove all ASCII whitespace without regex, so assertions ignore formatting. */
function stripWs(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch !== " " && ch !== "\n" && ch !== "\t" && ch !== "\r") out += ch;
  }
  return out;
}

function sliceBetween(src: string, startAnchor: string, endAnchor: string): string {
  const start = src.indexOf(startAnchor);
  const end = src.indexOf(endAnchor, start + startAnchor.length);
  expect(start, `start anchor not found: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  expect(end, `end anchor not found: ${endAnchor}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("start.mjs Windows boot-install cwd handling (#861)", () => {
  const BLOCK = sliceBetween(
    START_MJS,
    "const NPM_INSTALL_BG_PKGS",
    "// Self-heal: create CLI shim",
  );
  const compact = stripWs(BLOCK);

  it("prefers invoking npm's CLI through node with shell:false (cwd honored)", () => {
    expect(compact).toContain("npm-cli.js");
    expect(compact).toContain("process.execPath");
    expect(compact).toContain("shell:false");
  });

  it("suppresses the Windows console window (windowsHide)", () => {
    expect(compact).toContain("windowsHide:true");
  });

  it("keeps a no-regression fallback to the npm shim", () => {
    // The shim path (spawn(NPM_BIN, …)) is retained for hosts where npm-cli.js
    // cannot be located — so behavior on a working host is unchanged. This also
    // preserves the #634 contract asserted by start-mjs-mcp-boot.test.ts.
    expect(compact).toContain("spawn(NPM_BIN,");
  });

  it("still pins cwd to the plugin dir and keeps the detached background contract", () => {
    expect(compact).toContain("cwd:__dirname");
    expect(compact).toContain("detached:true");
    expect(compact).toContain(".unref()");
  });

  it("surfaces install failures to stderr instead of swallowing them", () => {
    // The EPERM was invisible for months behind stdio:"ignore" + an empty
    // error handler. Failures must now be written to stderr.
    expect(compact).toContain("process.stderr.write");
    expect(compact).not.toContain('child.on("error",()=>{');
  });

  it("still installs all three fetch deps", () => {
    for (const pkg of ["turndown", "turndown-plugin-gfm", "@mixmark-io/domino"]) {
      expect(BLOCK).toContain(`"${pkg}"`);
    }
  });
});

describe("runtime property the #861 fix relies on", () => {
  it("spawn with shell:false honors the cwd option (the fix's guarantee)", () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "cm861-")));
    const r = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(process.cwd())"],
      { cwd: d, shell: false, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(realpathSync(r.stdout.trim())).toBe(d);
  });
});
