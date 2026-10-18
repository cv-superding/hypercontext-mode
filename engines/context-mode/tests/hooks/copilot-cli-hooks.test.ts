/**
 * copilot-cli capture hooks — UserPromptSubmit / PreCompact / Stop, plus the
 * PreToolUse fail-open brick guard.
 *
 * Spawns each hook script with a real Copilot-CLI-shaped (snake_case) payload
 * and asserts it persists to the session DB under ~/.copilot/context-mode/.
 * Regression guard for the Stop bug: a `session_end` event without a `data`
 * field throws inside insertEvent (createHash(undefined)) and is silently
 * dropped — the hook must supply data/category/priority.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO = resolve(__dirname, "..", "..");
const SID = "copilot-cap-session";
const CWD = "/tmp/copilot-cap-project";

function dispatch(hook: string, payload: Record<string, unknown>, home: string) {
  return spawnSync("node", [join(REPO, "hooks", "copilot-cli", hook)], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

function openDB(home: string): Database.Database {
  const dir = join(home, ".copilot", "context-mode", "sessions");
  const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".db")) : undefined;
  if (!file) throw new Error("no session DB created");
  return new Database(join(dir, file));
}

describe("copilot-cli capture hooks", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ctx-copilot-cap-"));
  });
  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("UserPromptSubmit captures a user_prompt event from the Copilot payload", () => {
    const r = dispatch("userpromptsubmit.mjs", { session_id: SID, cwd: CWD, prompt: "refactor the auth module" }, home);
    expect(r.status).toBe(0);
    const db = openDB(home);
    const types = db.prepare("select distinct type from session_events").all() as Array<{ type: string }>;
    expect(types.map((t) => t.type)).toContain("user_prompt");
    db.close();
  });

  test("Stop captures a session_end event (regression: data must be set or it is dropped)", () => {
    dispatch("userpromptsubmit.mjs", { session_id: SID, cwd: CWD, prompt: "do the work" }, home);
    const r = dispatch("stop.mjs", { session_id: SID, cwd: CWD, last_assistant_message: "all tests pass" }, home);
    expect(r.status).toBe(0);
    const db = openDB(home);
    const end = db.prepare("select data from session_events where type = 'session_end'").all() as Array<{ data: string }>;
    expect(end.length).toBe(1);
    expect(end[0].data).toContain("all tests pass");
    db.close();
  });

  test("PreCompact writes a resume snapshot + bumps compact_count when history exists", () => {
    dispatch("userpromptsubmit.mjs", { session_id: SID, cwd: CWD, prompt: "build the feature" }, home);
    const r = dispatch("precompact.mjs", { session_id: SID, cwd: CWD }, home);
    expect(r.status).toBe(0);
    const db = openDB(home);
    expect((db.prepare("select count(*) c from session_resume").get() as { c: number }).c).toBe(1);
    expect((db.prepare("select compact_count cc from session_meta").get() as { cc: number }).cc).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

describe("copilot-cli PreToolUse fail-open (brick guard)", () => {
  test("a payload that throws exits 0 with no deny (must not brick Copilot CLI 1.0.59)", () => {
    // parseStdin runs JSON.parse, so malformed stdin throws inside the hook body.
    // Without the fail-open try/catch the process would exit non-zero with empty
    // stdout, which Copilot CLI 1.0.59 reads as "Denied by preToolUse hook (hook
    // errored)" and uses to block EVERY tool. Fail-open => exit 0 and no deny so
    // the host ALLOWS the tool; only context-mode's routing is skipped.
    const r = spawnSync("node", [join(REPO, "hooks", "copilot-cli", "pretooluse.mjs")], {
      input: "not-json{{",
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout ?? "").not.toContain("permissionDecision");
  });
});
