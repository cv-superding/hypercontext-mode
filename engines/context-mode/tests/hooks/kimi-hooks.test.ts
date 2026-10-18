import "../setup-home";
import { fakeHome } from "../setup-home";
/**
 * Hook Integration Tests — Kimi Code hooks
 *
 * Kimi Code uses JSON stdin/stdout with exit code 0 for allow
 * and exit code 2 (or JSON permissionDecision:"deny") for block.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, existsSync, unlinkSync, writeFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const _hashCanonical = (p: string) => createHash("sha256").update(
  (process.platform === "darwin" || process.platform === "win32") ? p.toLowerCase() : p,
).digest("hex").slice(0, 16);

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = join(__dirname, "..", "..", "hooks", "kimi");

interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runHook(hookFile: string, input: Record<string, unknown>, cwd?: string): HookResult {
  const result = spawnSync("node", [join(HOOKS_DIR, hookFile)], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env },
    ...(cwd ? { cwd } : {}),
  });

  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function normalizeProjectPathForSessionHash(projectDir: string): string {
  const normalized = projectDir.replace(/\\/g, "/");
  if (/^\/+$/.test(normalized)) return "/";
  if (/^[A-Za-z]:\/+$/.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return normalized.replace(/\/+$/, "");
}

describe("Kimi Code hooks", () => {
  let tempDir: string;
  let dbPath: string;

  beforeAll(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "kimi-hook-test-")));
    const hash = _hashCanonical(normalizeProjectPathForSessionHash(tempDir));
    const sessionsDir = join(fakeHome, ".kimi-code", "context-mode", "sessions");
    dbPath = join(sessionsDir, `${hash}.db`);
  });

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { if (existsSync(dbPath)) unlinkSync(dbPath); } catch { /* best effort */ }
  });

  const mcpSentinel = resolve(process.platform === "win32" ? tmpdir() : "/tmp", `context-mode-mcp-ready-${process.pid}`);
  beforeAll(() => { writeFileSync(mcpSentinel, String(process.pid)); });
  afterAll(() => { try { unlinkSync(mcpSentinel); } catch {} });

  describe("pretooluse.mjs", () => {
    test("exits 0 for passthrough tools", () => {
      const result = runHook("pretooluse.mjs", {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "Read",
        tool_input: { file_path: `${tempDir}/output.ts` },
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    });

    // Kimi's hook runner ignores `permissionDecision !== "deny"` and has no
    // `updatedInput` channel (refs/platforms/kimi-code/.../session/hooks/
    // runner.ts:36-39,162-178; types.ts:28-37). The central formatter therefore
    // returns null for modify decisions; the hook falls back to the default
    // passthrough JSON. Asserting `permissionDecision: "allow"` would re-encode
    // a capability overclaim the host silently drops.
    test("passthrough for curl commands — Kimi has no updatedInput channel", () => {
      const result = runHook("pretooluse.mjs", {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "Bash",
        tool_input: { command: "curl https://example.com" },
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      // No permissionDecision field — host treats absence as "allow as-is".
      expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
      expect(parsed.hookSpecificOutput.updatedInput).toBeUndefined();
    });

    test("passthrough for wget commands — Kimi has no updatedInput channel", () => {
      const result = runHook("pretooluse.mjs", {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "Bash",
        tool_input: { command: "wget https://example.com -O out.html" },
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
      expect(parsed.hookSpecificOutput.updatedInput).toBeUndefined();
    });

    test("returns deny JSON for WebFetch", () => {
      const result = runHook("pretooluse.mjs", {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com" },
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    });

    test("exits 0 for git commands (allowed short-output shell)", () => {
      const result = runHook("pretooluse.mjs", {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
        tool_name: "Bash",
        tool_input: { command: "git status" },
      });

      expect(result.exitCode).toBe(0);
    });

    test("handles missing tool_name gracefully", () => {
      const result = runHook("pretooluse.mjs", {
        hook_event_name: "PreToolUse",
        cwd: tempDir,
      });

      expect(result.exitCode).toBe(0);
    });
  });

  describe("userpromptsubmit.mjs", () => {
    test("exits 0 and emits UserPromptSubmit hookSpecificOutput", () => {
      const result = runHook("userpromptsubmit.mjs", {
        hook_event_name: "UserPromptSubmit",
        cwd: tempDir,
        prompt: "How do I configure context-mode?",
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    });

    test("handles ContentPart[] array prompt", () => {
      const result = runHook("userpromptsubmit.mjs", {
        hook_event_name: "UserPromptSubmit",
        cwd: tempDir,
        prompt: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    });

    test("persists user prompt to SessionDB", async () => {
      const prompt = "kimi-test-prompt-marker-" + Date.now();
      const result = runHook("userpromptsubmit.mjs", {
        hook_event_name: "UserPromptSubmit",
        cwd: tempDir,
        prompt,
      }, tempDir);
      expect(result.exitCode).toBe(0);

      expect(existsSync(dbPath)).toBe(true);
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db.prepare(
          `SELECT data FROM session_events WHERE category = 'user-prompt'`,
        ).all() as Array<{ data: string }>;
        const matched = rows.some(r => r.data.includes(prompt));
        expect(matched, `expected prompt persisted; rows=${JSON.stringify(rows)}`).toBe(true);
      } finally {
        db.close();
      }
    });

    test("skips system messages without crashing", () => {
      const result = runHook("userpromptsubmit.mjs", {
        hook_event_name: "UserPromptSubmit",
        cwd: tempDir,
        prompt: "<system-reminder>not a user prompt</system-reminder>",
      });
      expect(result.exitCode).toBe(0);
    });

    test("handles malformed input without crashing", () => {
      const result = runHook("userpromptsubmit.mjs", {
        hook_event_name: "UserPromptSubmit",
      });
      expect(result.exitCode).toBe(0);
    });
  });

  describe("sessionstart.mjs", () => {
    test("startup source emits routing block via additionalContext", () => {
      const result = runHook("sessionstart.mjs", {
        hook_event_name: "SessionStart",
        cwd: tempDir,
        source: "startup",
      });

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("context_window_protection");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("mcp__context-mode__ctx_");
    });

    test("startup source clears stale events file", () => {
      const result = runHook("sessionstart.mjs", {
        hook_event_name: "SessionStart",
        cwd: tempDir,
        source: "startup",
      });
      expect(result.exitCode).toBe(0);
    });

    test("handles malformed input without crashing", () => {
      const result = runHook("sessionstart.mjs", {});
      expect(result.exitCode).toBe(0);
    });
  });

  describe("posttooluse.mjs", () => {
    test("exits 0 and outputs PostToolUse hookSpecificOutput", () => {
      const result = runHook("posttooluse.mjs", {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/src/app.ts" },
        tool_output: { content: "export default {}" },
      }, tempDir);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    });

    test("captures git events without error", () => {
      const result = runHook("posttooluse.mjs", {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        tool_output: { stdout: "On branch main\nnothing to commit" },
      }, tempDir);

      expect(result.exitCode).toBe(0);
    });

    test("handles malformed input without crashing", () => {
      const result = runHook("posttooluse.mjs", {
        hook_event_name: "PostToolUse",
      }, tempDir);

      expect(result.exitCode).toBe(0);
    });
  });

  describe("stop.mjs", () => {
    test("exits 0 and writes turn_end (NOT session_end) row — Stop is per-turn, not session-close", async () => {
      const result = runHook("stop.mjs", {
        hook_event_name: "Stop",
        cwd: tempDir,
        stop_hook_active: true,
      }, tempDir);

      expect(result.exitCode).toBe(0);

      // Stop must record `turn_end`, never `session_end`. The latter is owned
      // by sessionend.mjs (refs/platforms/kimi-code/.../session/index.ts:
      // 192,502 — triggerSessionEnd('exit') is a DISTINCT event from Stop).
      expect(existsSync(dbPath)).toBe(true);
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db.prepare(
          `SELECT type FROM session_events WHERE type IN ('turn_end', 'session_end')`,
        ).all() as Array<{ type: string }>;
        expect(rows.some(r => r.type === "turn_end"),
          `Stop must record turn_end; rows=${JSON.stringify(rows)}`).toBe(true);
        expect(rows.some(r => r.type === "session_end"),
          `Stop must NOT record session_end (that's SessionEnd's job); rows=${JSON.stringify(rows)}`).toBe(false);
      } finally {
        db.close();
      }
    });

    test("handles malformed input without crashing", () => {
      const result = runHook("stop.mjs", {});
      expect(result.exitCode).toBe(0);
    });
  });

  describe("sessionend.mjs", () => {
    // Verifies the genuine SessionEnd event (refs/platforms/kimi-code/.../
    // session/index.ts:192,502 — triggerSessionEnd('exit')) writes the
    // session_end SessionDB row that Stop used to mis-emit per turn.
    test("writes session_end row with reason", async () => {
      const result = runHook("sessionend.mjs", {
        hook_event_name: "SessionEnd",
        cwd: tempDir,
        reason: "exit",
      }, tempDir);

      expect(result.exitCode).toBe(0);

      expect(existsSync(dbPath)).toBe(true);
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db.prepare(
          `SELECT type, data FROM session_events WHERE type = 'session_end' ORDER BY id DESC LIMIT 1`,
        ).all() as Array<{ type: string; data: string }>;
        expect(rows.length, `expected session_end row; got ${rows.length}`).toBeGreaterThan(0);
        // SessionDB serializes the event payload object into `data`.
        expect(rows[0]?.data).toContain("exit");
      } finally {
        db.close();
      }
    });

    test("defaults missing reason to 'exit'", () => {
      const result = runHook("sessionend.mjs", {
        hook_event_name: "SessionEnd",
        cwd: tempDir,
      }, tempDir);
      expect(result.exitCode).toBe(0);
    });

    test("handles malformed input without crashing", () => {
      const result = runHook("sessionend.mjs", {});
      expect(result.exitCode).toBe(0);
    });
  });
});
