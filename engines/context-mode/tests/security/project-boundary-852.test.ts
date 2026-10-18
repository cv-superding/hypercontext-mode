/**
 * Issue #852 — ctx_execute_file project-boundary containment.
 *
 * Repro: with the host sandbox enabled, an agent asks to read a file OUTSIDE
 * the project (e.g. `/home/user/some-private-dir/index.ts`). The host denies
 * it, the agent retries via `ctx_execute_file`, and the file is read because
 * the executor fed the path straight into `resolve(projectRoot, path)` where an
 * absolute path (or `../` traversal) escapes the workspace. The host's MCP
 * approval prompt cannot inspect the params, so the escape went unseen.
 *
 * These tests pin the pure containment primitive `isPathInsideProject`, which
 * the server guard `checkProjectBoundary` uses to refuse out-of-project paths.
 *
 * No regex in the implementation — pure `path.relative`/`path.resolve` math.
 */

import { describe, it, expect, beforeAll, afterAll, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isPathInsideProject, evaluateProjectContainment } from "../../src/security.js";

describe("isPathInsideProject — issue #852 containment", () => {
  let project: string;
  let outside: string;

  beforeAll(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ctx-852-proj-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "ctx-852-out-")));
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
  });

  afterAll(() => {
    for (const d of [project, outside]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("ALLOWS a relative path inside the project", () => {
    expect(isPathInsideProject("src/app.ts", project)).toBe(true);
  });

  it("ALLOWS an absolute path inside the project", () => {
    expect(isPathInsideProject(join(project, "src", "app.ts"), project)).toBe(true);
  });

  it("ALLOWS the project root itself", () => {
    expect(isPathInsideProject(project, project)).toBe(true);
  });

  it("BLOCKS an absolute path outside the project (the #852 repro)", () => {
    // `/home/user/some-private-dir/index.ts`-equivalent: a real absolute path
    // that resolve(projectRoot, abs) would happily hand back verbatim.
    expect(isPathInsideProject(join(outside, "secret.txt"), project)).toBe(false);
  });

  it("BLOCKS a ../ traversal that escapes the project", () => {
    expect(isPathInsideProject("../../../../etc/passwd", project)).toBe(false);
  });

  it("BLOCKS a path that climbs out and is NOT a prefix-sibling of the root", () => {
    // A sibling dir whose name starts with the project basename must NOT be
    // mistaken for "inside" via naive string-prefix matching.
    expect(isPathInsideProject(project + "-evil/secret", project)).toBe(false);
  });

  it("BLOCKS a project-local symlink whose target escapes the project", () => {
    const link = join(project, "escape-link");
    try {
      symlinkSync(join(outside, "secret.txt"), link);
    } catch {
      // Symlink creation can fail on restricted CI (esp. Windows) — skip then.
      return;
    }
    expect(isPathInsideProject("escape-link", project)).toBe(false);
  });

  it("fail-open: returns true when no project root is known", () => {
    expect(isPathInsideProject("/anywhere/at/all", undefined)).toBe(true);
  });

  // ── Escape hatch via host permissions.allow Read(...) rules ──
  it("containment ALLOWS an in-project path with no allow rules (reason: inside)", () => {
    const v = evaluateProjectContainment(join(project, "src", "app.ts"), project, []);
    expect(v).toEqual({ allowed: true, reason: "inside" });
  });

  it("containment DENIES an out-of-project path with no allow rules (reason: outside)", () => {
    const v = evaluateProjectContainment(join(outside, "secret.txt"), project, []);
    expect(v).toEqual({ allowed: false, reason: "outside" });
  });

  it("containment ALLOWS an out-of-project path matched by a host Read(...) allow rule", () => {
    // The user opts a specific out-of-project path back in via the SAME host
    // permissions.allow mechanism Claude Code uses — not a context-mode env.
    const allowGlobs = [[join(outside, "**")]];
    const v = evaluateProjectContainment(join(outside, "secret.txt"), project, allowGlobs);
    expect(v).toEqual({ allowed: true, reason: "allow-rule" });
  });

  it("containment still DENIES an out-of-project path NOT covered by the allow rule", () => {
    const allowGlobs = [["/some/unrelated/path/**"]];
    const v = evaluateProjectContainment(join(outside, "secret.txt"), project, allowGlobs);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("outside");
  });
});

// ─────────────────────────────────────────────────────────
// Server wiring — the boundary guard must be installed in the
// ctx_execute_file handler, resolve via the canonical getProjectDir(),
// and expose a documented opt-out env. (Source-structural, mirroring
// tests/core/deny-policy.test.ts.)
// ─────────────────────────────────────────────────────────
describe("ctx_execute_file: project-boundary guard wiring (#852)", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(resolve(__dirname, "../../src/server.ts"), "utf-8");

  // Algorithmic source-introspection helpers (no regex — project no-regex rule).
  // extractBlock: slice from a marker to the first top-level closing brace ("\n}").
  function extractBlock(src: string, marker: string): string | null {
    const start = src.indexOf(marker);
    if (start === -1) return null;
    const end = src.indexOf("\n}", start);
    return end === -1 ? src.slice(start) : src.slice(start, end + 2);
  }

  // titleAfter: the first double-quoted string following a `title:` key that
  // appears after `marker` — equivalent to capturing group 1 of the old regex.
  function titleAfter(src: string, marker: string): string | null {
    const i = src.indexOf(marker);
    if (i === -1) return null;
    const t = src.indexOf("title:", i);
    if (t === -1) return null;
    const q1 = src.indexOf('"', t);
    const q2 = src.indexOf('"', q1 + 1);
    return q1 === -1 || q2 === -1 ? null : src.slice(q1 + 1, q2);
  }

  test("checkProjectBoundary helper exists", () => {
    expect(serverSrc).toContain("function checkProjectBoundary");
  });

  test("guard resolves via canonical getProjectDir() and evaluateProjectContainment", () => {
    const body = extractBlock(serverSrc, "function checkProjectBoundary");
    expect(body).not.toBeNull();
    expect(body!).toContain("getProjectDir()");
    expect(body!).toContain("evaluateProjectContainment");
  });

  test("ctx_execute_file handler calls the boundary guard", () => {
    // The guard must run inside the ctx_execute_file handler.
    expect(serverSrc).toContain('checkProjectBoundary(path, "ctx_execute_file")');
  });

  test("escape hatch reuses host permissions.allow Read rules — NO bespoke opt-out env", () => {
    // Principled escape hatch: read the host's existing allow rules, not a
    // context-mode-specific env that would become dead code.
    const body = extractBlock(serverSrc, "function checkProjectBoundary")!;
    expect(body).toContain('readToolPermissionPatterns("Read", "allow"');
    // The dead-code env flag must NOT exist anywhere in server.ts.
    expect(serverSrc).not.toContain("CONTEXT_MODE_ALLOW_OUTSIDE_PROJECT");
    expect(serverSrc).not.toContain("allowOutsideProject");
  });

  test("execution tools announce code execution in their MCP-prompt title (#852)", () => {
    // refs(claude-code): the approval prompt renders `serverName - <title> (MCP)`;
    // the title is the one server-controlled field, so it must read as code-exec.
    const execTitle = titleAfter(serverSrc, '"ctx_execute",');
    const fileTitle = titleAfter(serverSrc, '"ctx_execute_file",');
    expect(execTitle?.toLowerCase()).toContain("code");
    const fileLower = fileTitle?.toLowerCase() ?? "";
    expect(fileLower.includes("code") || fileLower.includes("execute")).toBe(true);
  });
});
