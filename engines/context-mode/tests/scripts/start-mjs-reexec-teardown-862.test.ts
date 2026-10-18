/**
 * start.mjs Linux re-exec proxy MUST propagate parent death — closes #862.
 *
 * On Linux, when invoked under `node`, start.mjs re-execs itself under Bun to
 * dodge the better-sqlite3 SIGSEGV (#564, f985afa0). The original proxy parked
 * the node process forwarding stdin to the Bun child, but installed a NO-OP
 * stdin EOF handler:
 *
 *     process.stdin.on("end", () => {});            // <-- swallows parent death
 *     const _keepAlive = setInterval(() => {}, 2147483647);
 *     await new Promise(() => {});                   // park forever
 *
 * So when the MCP client (e.g. Claude Code) exits, the proxy neither closed the
 * child's stdin nor exited. The child's stdin (this pipe) stayed open and its
 * direct parent (the parked proxy) stayed alive — defeating BOTH shutdown paths
 * of the child's lifecycle guard (stdio-EOF assist AND ppid poll). The orphaned
 * pair reparented to init (PPID=1) and pinned a CPU core indefinitely; @elhoim
 * observed 5 such orphans burning ~3 of 6 cores.
 *
 * The fix propagates parent death: any of stdin `end` / `close` / `error` tears
 * the child down — forward EOF (graceful self-reap via the child's own
 * watchdog), then escalate SIGTERM → SIGKILL so a wedged child can never outlive
 * its client — while still re-execing under Bun (#564 preserved).
 *
 * SEAM NOTE: this is intentionally a source-introspection test, matching the
 * established start.mjs pattern (tests/scripts/start-mjs-mcp-boot.test.ts, #634).
 * start.mjs is a side-effecting raw entry script — importing it would run the
 * self-heal + proxy spawn, and shipping the proxy logic as a separate importable
 * boot-path module is a worse distribution risk (a partial install would fail to
 * boot on EVERY platform) than the Linux-only orphan this guards. So we pin the
 * fix against silent revert at the text level.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

/** Slice between two literal anchors (exclusive of the trailing anchor). */
function sliceBetween(src: string, startAnchor: string, endAnchor: string): string {
  const start = src.indexOf(startAnchor);
  const end = src.indexOf(endAnchor, start + startAnchor.length);
  expect(start, `start anchor not found: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  expect(end, `end anchor not found: ${endAnchor}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("start.mjs Linux re-exec proxy lifecycle (#862)", () => {
  const PROXY_BLOCK = sliceBetween(
    START_MJS,
    "// ── Linux: re-exec with Bun",
    "// ── Self-heal Layer 1",
  );
  const compact = stripWs(PROXY_BLOCK);

  it("still re-execs under Bun on Linux node invocations (#564 preserved)", () => {
    expect(PROXY_BLOCK).toContain('process.platform === "linux"');
    expect(compact).toContain("spawn(bunBin,");
  });

  it("does NOT leave the parent stdin EOF handler a no-op", () => {
    // The exact #862 defect: `on("end", () => {})`. Any whitespace variant of an
    // empty end handler is forbidden.
    expect(compact).not.toContain('.on("end",()=>{})');
  });

  it("propagates parent death from all three pipe-teardown events", () => {
    // EOF, pipe close, and pipe error all mean "the MCP client is gone".
    expect(compact).toContain('.on("end",');
    expect(compact).toContain('.on("close",');
    expect(compact).toContain('.on("error",');
  });

  it("forwards EOF to the child so it self-reaps via its own watchdog", () => {
    expect(compact).toContain("child.stdin.end()");
  });

  it("escalates SIGTERM then SIGKILL so a wedged child cannot outlive the client", () => {
    expect(compact).toContain('child.kill("SIGTERM")');
    expect(compact).toContain('child.kill("SIGKILL")');
  });

  it("still clears the keep-alive timer when the child exits", () => {
    expect(compact).toContain("clearInterval(_keepAlive)");
    expect(compact).toContain('child.on("exit",');
  });
});
