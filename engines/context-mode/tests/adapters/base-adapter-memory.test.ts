import "../setup-home";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BaseAdapter } from "../../src/adapters/base.js";
import { hashProjectDirCanonical } from "../../src/session/db.js";

/**
 * BaseAdapter memory/config dispatch defaults.
 *
 * Slice 1 of the adapter-aware persistent memory rework.
 * Verifies the three new defaults BaseAdapter exposes for
 * auto-memory + ctx_search timeline + rule detection:
 *   - getConfigDir()       — derived from sessionDirSegments
 *   - getInstructionFiles()— defaults to ["CLAUDE.md"] (Claude convention)
 *   - getMemoryDir()       — defaults to <configDir>/memory
 */

class TestAdapter extends BaseAdapter {
  constructor(segments: string[]) {
    super(segments);
  }
  getSettingsPath(): string {
    return join(this.getConfigDir(), "settings.json");
  }
}

describe("BaseAdapter memory/config defaults", () => {
  it("getConfigDir returns $HOME joined with sessionDirSegments (single segment)", () => {
    const adapter = new TestAdapter([".claude"]);
    expect(adapter.getConfigDir()).toBe(join(homedir(), ".claude"));
  });

  it("getConfigDir handles multi-segment sessionDirSegments", () => {
    const adapter = new TestAdapter([".config", "zed"]);
    expect(adapter.getConfigDir()).toBe(join(homedir(), ".config", "zed"));
  });

  it("getInstructionFiles defaults to ['CLAUDE.md']", () => {
    const adapter = new TestAdapter([".claude"]);
    expect(adapter.getInstructionFiles()).toEqual(["CLAUDE.md"]);
  });

  it("getMemoryDir defaults to <configDir>/memory", () => {
    const adapter = new TestAdapter([".claude"]);
    expect(adapter.getMemoryDir()).toBe(join(homedir(), ".claude", "memory"));
  });
});

// Issue #649 — CONTEXT_MODE_DATA_DIR universal storage override.
//
// Several adapters (Pi, OMP, Gemini CLI, Codex, Cursor, …) hardcode their
// storage root to `~/.<platform>/context-mode/sessions/` with no env-var
// escape hatch. CI runners, dev containers, and NFS-home users need to point
// context-mode storage at a writable volume without patching source or
// changing the host platform's own config-dir variable.
//
// Contract for CONTEXT_MODE_DATA_DIR:
//   - Unset / empty / whitespace-only → use platform-native default (no-op).
//   - Set                              → `<DATA_DIR>/context-mode/sessions/`
//                                        for getSessionDir(), and
//                                        `<DATA_DIR>/context-mode/memory/`
//                                        for getMemoryDir().
//   - Tilde + relative path handling mirrors `resolveClaudeConfigDir`
//     (~ expands to homedir, relative paths resolve against cwd).
//   - getConfigDir() is platform-native (settings.json, hooks.json) and is
//     NOT relocated — only context-mode-owned state moves.
describe("BaseAdapter — CONTEXT_MODE_DATA_DIR override (#649)", () => {
  const ENV_KEY = "CONTEXT_MODE_DATA_DIR";
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("getSessionDir uses CONTEXT_MODE_DATA_DIR root when set (overrides homedir)", () => {
    const adapter = new TestAdapter([".pi"]);
    process.env[ENV_KEY] = "/tmp/custom-data";
    expect(adapter.getSessionDir()).toBe(
      resolve("/tmp/custom-data", "context-mode", "sessions"),
    );
  });

  it("getSessionDir falls back to <home>/<segments>/context-mode/sessions when env unset", () => {
    const adapter = new TestAdapter([".pi"]);
    expect(adapter.getSessionDir()).toBe(
      join(homedir(), ".pi", "context-mode", "sessions"),
    );
  });

  it("getSessionDir treats empty/whitespace env value as unset (safety guard)", () => {
    const adapter = new TestAdapter([".gemini"]);
    process.env[ENV_KEY] = "   ";
    expect(adapter.getSessionDir()).toBe(
      join(homedir(), ".gemini", "context-mode", "sessions"),
    );
  });

  it("getSessionDir expands leading tilde against homedir (~/foo, ~\\foo)", () => {
    const adapter = new TestAdapter([".omp"]);
    process.env[ENV_KEY] = "~/relocated-storage";
    expect(adapter.getSessionDir()).toBe(
      resolve(homedir(), "relocated-storage", "context-mode", "sessions"),
    );
  });

  it("getMemoryDir relocates to <DATA_DIR>/context-mode/memory when env set", () => {
    const adapter = new TestAdapter([".pi"]);
    process.env[ENV_KEY] = "/tmp/custom-data";
    expect(adapter.getMemoryDir()).toBe(
      resolve("/tmp/custom-data", "context-mode", "memory"),
    );
  });

  it("getMemoryDir defaults to <configDir>/memory when env unset", () => {
    const adapter = new TestAdapter([".pi"]);
    expect(adapter.getMemoryDir()).toBe(join(homedir(), ".pi", "memory"));
  });

  it("getConfigDir is NOT relocated by CONTEXT_MODE_DATA_DIR (platform-native settings stay put)", () => {
    const adapter = new TestAdapter([".pi"]);
    process.env[ENV_KEY] = "/tmp/custom-data";
    // settings.json belongs with the platform install, not with context-mode
    // storage — relocating it would silently fork platform behaviour from
    // platform tooling. The override only moves context-mode-owned state.
    expect(adapter.getConfigDir()).toBe(join(homedir(), ".pi"));
  });
});

// C2 narrowing — BaseAdapter MUST NOT expose path helpers that are pure
// derivatives of `getSessionDir() + projectDir`. Those derivatives belong
// in `src/session/db.ts:resolveSessionDbPath` (single site of computation,
// case-fold migration, worktree-suffix handling). Exposing them on every
// adapter is a SHALLOW interface — its complexity equals its implementation
// — and tempts adapter authors to override for cargo-cult reasons (e.g. the
// pre-narrowing CodexAdapter override that just delegated to the same
// helper). Deletion test: collapses to ONE call site, complexity does NOT
// reappear in N callers.
describe("BaseAdapter — adapter-storage interface narrowing (C2)", () => {
  it("does NOT expose getSessionDBPath — callers go through resolveSessionDbPath", () => {
    const adapter = new TestAdapter([".claude"]);
    // Use Reflect to interrogate the runtime shape — the cast is intentional;
    // we are pinning that the public surface no longer carries this method.
    expect((adapter as unknown as Record<string, unknown>).getSessionDBPath).toBeUndefined();
  });

  it("does NOT expose getSessionEventsPath — events.md path lives in callers/server", () => {
    const adapter = new TestAdapter([".claude"]);
    expect((adapter as unknown as Record<string, unknown>).getSessionEventsPath).toBeUndefined();
  });
});

// Issue #663 — auto-memory leaks across projects.
//
// Before this fix, `getMemoryDir()` ignored `projectDir` and every adapter
// (except OpenClaw, whose configDir is the project root) returned a path
// shared by every project on the machine. Two terminals open in different
// repos read each other's memory files via searchAutoMemory().
//
// Contract for the scoped form:
//   - `getMemoryDir(projectDir)`                → `<base>/<hashProjectDirCanonical(projectDir)>`
//   - `getMemoryDir()` (legacy, no projectDir)  → `<base>` (unscoped) for backwards compat
//   - Two distinct projectDirs                  → two distinct paths
//   - Same projectDir on repeat calls           → identical path (deterministic)
//
// `CONTEXT_MODE_DATA_DIR` continues to relocate the root; the hash suffix
// sits underneath whichever root is active.
describe("BaseAdapter — getMemoryDir project scoping (#663)", () => {
  const ENV_KEY = "CONTEXT_MODE_DATA_DIR";
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("getMemoryDir(projectDir) appends hashProjectDirCanonical(projectDir)", () => {
    const adapter = new TestAdapter([".claude"]);
    const projectDir = "/Users/test/projects/alpha";
    const expected = join(
      homedir(),
      ".claude",
      "memory",
      hashProjectDirCanonical(projectDir),
    );
    expect(adapter.getMemoryDir(projectDir)).toBe(expected);
  });

  it("two different projectDirs yield two different paths", () => {
    const adapter = new TestAdapter([".claude"]);
    const a = adapter.getMemoryDir("/Users/test/projects/alpha");
    const b = adapter.getMemoryDir("/Users/test/projects/beta");
    expect(a).not.toBe(b);
  });

  it("same projectDir is deterministic across calls", () => {
    const adapter = new TestAdapter([".claude"]);
    const p = "/Users/test/projects/gamma";
    expect(adapter.getMemoryDir(p)).toBe(adapter.getMemoryDir(p));
  });

  it("getMemoryDir() without projectDir returns the legacy unscoped path (backwards compat)", () => {
    const adapter = new TestAdapter([".claude"]);
    expect(adapter.getMemoryDir()).toBe(join(homedir(), ".claude", "memory"));
  });

  it("hash suffix lives under CONTEXT_MODE_DATA_DIR root when env is set", () => {
    const adapter = new TestAdapter([".pi"]);
    process.env[ENV_KEY] = "/tmp/custom-data";
    const projectDir = "/Users/test/projects/delta";
    expect(adapter.getMemoryDir(projectDir)).toBe(
      join(
        resolve("/tmp/custom-data"),
        "context-mode",
        "memory",
        hashProjectDirCanonical(projectDir),
      ),
    );
  });
});
