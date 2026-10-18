import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolyglotExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime.js";

// ─────────────────────────────────────────────────────────
// Issue #45 / c4529042182 — defense-in-depth.
// Even when resolveProjectDir() returns the wrong path (e.g. plugin
// install dir, $HOME, or PWD pre-chdir), the executor must accept an
// explicit cwd override on ExecuteOptions so per-call sites (Codex MCP
// handlers) can pin the shell working directory to the resolved
// project root without mutating process-wide state.
// ─────────────────────────────────────────────────────────

const runtimes = detectRuntimes();

// `pwd` is shell-builtin and on Windows Git Bash MSYS-translates
// `C:\Users\RUNNER~1\...\Temp\xxx` → `/tmp/xxx`. Print cwd from Node
// instead so the output format matches `mkdtempSync` on all platforms.
const PRINT_CWD = `node -p "process.cwd()"`;

// realpath both sides: on Windows it expands 8.3 short names
// (RUNNER~1 → runneradmin); on macOS it follows /var → /private/var.
// On case-insensitive filesystems (Windows, default macOS) compare
// case-insensitively — `mkdtempSync` may differ in case from realpath.
const normalize = (p: string) => {
  const real = realpathSync(p);
  return process.platform === "win32" || process.platform === "darwin"
    ? real.toLowerCase()
    : real;
};

describe("PolyglotExecutor cwd override", () => {
  it("uses explicit cwd over projectRoot for shell language", async () => {
    const realDir = mkdtempSync(join(tmpdir(), "ctx-cwd-real-"));
    const wrongDir = mkdtempSync(join(tmpdir(), "ctx-cwd-wrong-"));

    try {
      const executor = new PolyglotExecutor({
        runtimes,
        projectRoot: () => wrongDir,
      });
      const result = await executor.execute({
        language: "shell",
        code: PRINT_CWD,
        cwd: realDir,
      });

      expect(result.exitCode).toBe(0);
      expect(normalize(result.stdout.trim())).toBe(normalize(realDir));
    } finally {
      try { rmSync(realDir, { recursive: true, force: true }); } catch {}
      try { rmSync(wrongDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("falls back to projectRoot when cwd is undefined", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ctx-proj-"));

    try {
      const executor = new PolyglotExecutor({
        runtimes,
        projectRoot: () => projectDir,
      });
      const result = await executor.execute({
        language: "shell",
        code: PRINT_CWD,
      });

      expect(result.exitCode).toBe(0);
      expect(normalize(result.stdout.trim())).toBe(normalize(projectDir));
    } finally {
      try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
    }
  });
});
