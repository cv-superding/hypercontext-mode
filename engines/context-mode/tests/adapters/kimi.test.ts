import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { KimiAdapter, probeKimiCliVersion } from "../../src/adapters/kimi/index.js";
import { resolveSessionDbPath, SessionDB } from "../../src/session/db.js";

describe("KimiAdapter", () => {
  let adapter: KimiAdapter;

  beforeEach(() => {
    adapter = new KimiAdapter();
  });

  // ── Capabilities ──────────────────────────────────────

  describe("capabilities", () => {
    it("preToolUse is true", () => {
      expect(adapter.capabilities.preToolUse).toBe(true);
    });

    it("postToolUse is true", () => {
      expect(adapter.capabilities.postToolUse).toBe(true);
    });

    it("sessionStart is true", () => {
      expect(adapter.capabilities.sessionStart).toBe(true);
    });

    it("preCompact is true", () => {
      expect(adapter.capabilities.preCompact).toBe(true);
    });

    it("canModifyArgs is false (Kimi deny-only runner)", () => {
      expect(adapter.capabilities.canModifyArgs).toBe(false);
    });

    it("canModifyOutput is false (Kimi does not support updatedMCPToolOutput)", () => {
      expect(adapter.capabilities.canModifyOutput).toBe(false);
    });

    it("canInjectSessionContext is false (HookResult has no additionalContext field)", () => {
      expect(adapter.capabilities.canInjectSessionContext).toBe(false);
    });

    it("paradigm is json-stdio", () => {
      expect(adapter.paradigm).toBe("json-stdio");
    });
  });

  // ── parsePreToolUseInput ──────────────────────────────

  describe("parsePreToolUseInput", () => {
    it("extracts tool_name from input", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "s1",
        cwd: "/tmp",
        hook_event_name: "PreToolUse",
      });
      expect(event.toolName).toBe("Bash");
    });

    it("extracts session_id", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "kimi-123",
        cwd: "/proj",
        hook_event_name: "PreToolUse",
      });
      expect(event.sessionId).toBe("kimi-123");
    });

    it("extracts projectDir from cwd", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "s1",
        cwd: "/my/project",
        hook_event_name: "PreToolUse",
      });
      expect(event.projectDir).toBe("/my/project");
    });

    it("falls back to process.cwd() when cwd and env both missing", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "s1",
        hook_event_name: "PreToolUse",
      });
      expect(event.projectDir).toBe(process.cwd());
    });

    it("post/precompact/sessionstart parsers also fall back to process.cwd()", () => {
      const post = adapter.parsePostToolUseInput({ tool_name: "Bash" });
      expect(post.projectDir).toBe(process.cwd());

      const compact = adapter.parsePreCompactInput({ session_id: "s1" });
      expect(compact.projectDir).toBe(process.cwd());

      const start = adapter.parseSessionStartInput({ session_id: "s1" });
      expect(start.projectDir).toBe(process.cwd());
    });
  });

  // ── formatPreToolUseResponse ──────────────────────────

  describe("formatPreToolUseResponse", () => {
    it("returns deny payload with hookSpecificOutput when decision is deny", () => {
      const response = adapter.formatPreToolUseResponse({
        decision: "deny",
        reason: "Blocked for testing",
      });
      expect(response).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Blocked for testing",
        },
      });
    });

    it("returns empty object for allow decision", () => {
      const response = adapter.formatPreToolUseResponse({ decision: "allow" });
      expect(response).toEqual({});
    });

    it("returns empty object for modify decision (silently dropped by Kimi runner)", () => {
      const response = adapter.formatPreToolUseResponse({
        decision: "modify",
        updatedInput: { command: "echo modified" },
      });
      expect(response).toEqual({});
    });

    it("returns empty object for ask decision (silently dropped by Kimi runner)", () => {
      const response = adapter.formatPreToolUseResponse({ decision: "ask" });
      expect(response).toEqual({});
    });

    it("returns empty object for context decision (silently dropped by Kimi runner)", () => {
      const response = adapter.formatPreToolUseResponse({
        decision: "context",
        additionalContext: "some context",
      });
      expect(response).toEqual({});
    });

    it("uses default reason when deny reason is missing", () => {
      const response = adapter.formatPreToolUseResponse({ decision: "deny" });
      expect((response as any).hookSpecificOutput.permissionDecisionReason).toBe(
        "Blocked by context-mode hook",
      );
    });
  });

  // ── SessionStart source normalization ─────────────────

  describe("parseSessionStartInput", () => {
    it("normalizes 'startup' source", () => {
      const event = adapter.parseSessionStartInput({ session_id: "s1", source: "startup" });
      expect(event.source).toBe("startup");
    });

    it("normalizes 'resume' source", () => {
      const event = adapter.parseSessionStartInput({ session_id: "s1", source: "resume" });
      expect(event.source).toBe("resume");
    });

    it("defaults unknown source to 'startup' (Kimi never emits 'compact')", () => {
      const event = adapter.parseSessionStartInput({ session_id: "s1", source: "compact" });
      expect(event.source).toBe("startup");
    });
  });

  // ── probeKimiCliVersion ───────────────────────────────

  describe("probeKimiCliVersion", () => {
    it("returns version string when kimi binary is available", () => {
      const version = probeKimiCliVersion();
      if (version) {
        expect(typeof version).toBe("string");
        expect(version.length).toBeGreaterThan(0);
      }
    });

    it("returns null when kimi binary is not available", () => {
      const result = probeKimiCliVersion((): string => {
        throw new Error("ENOENT");
      });
      expect(result).toBeNull();
    });

    it("surfaces Kimi Code CLI binary availability in diagnostics", () => {
      const checks = adapter.validateHooks("");
      expect(checks.some((result) => result.check === "Kimi Code CLI binary")).toBe(true);
    });
  });

  // ── generateHookConfig ────────────────────────────────

  describe("generateHookConfig", () => {
    it("generates hooks with Kimi-supported continuity entries", () => {
      const config = adapter.generateHookConfig("/path/to/plugin");
      expect(config).toHaveProperty("PreToolUse");
      expect(config).toHaveProperty("PostToolUse");
      expect(config).toHaveProperty("PreCompact");
      expect(config).toHaveProperty("SessionStart");
      expect(config).toHaveProperty("SessionEnd");
      expect(config).toHaveProperty("UserPromptSubmit");
      expect(config).toHaveProperty("Stop");
      expect(config.PreToolUse[0]?.matcher).toContain("Bash");
      expect(config.PreToolUse[0]?.matcher).toContain("ctx_execute");
      expect(config.PreToolUse[0]?.matcher).toMatch(/(^|\|)mcp__$/);
      expect(config.SessionEnd[0]?.hooks[0]?.command).toBe("context-mode hook kimi sessionend");
      expect(config.Stop[0]?.hooks[0]?.command).toBe("context-mode hook kimi stop");
    });
  });

  // ── configureAllHooks ─────────────────────────────────

  describe("configureAllHooks", () => {
    const configPath = join(homedir(), ".kimi-code", "config.toml");
    const kimiDir = join(homedir(), ".kimi-code");

    beforeEach(() => {
      rmSync(kimiDir, { recursive: true, force: true });
    });

    it("writes managed Kimi hooks as [[hooks]] array tables in config.toml", () => {
      const changes = adapter.configureAllHooks("/ignored/plugin/root");
      const written = readFileSync(configPath, "utf-8");

      expect(changes.some((change) => change.includes("Wrote managed Kimi hooks"))).toBe(true);
      expect(written).toContain('[[hooks]]');
      expect(written).toContain('event = "PreToolUse"');
      expect(written).toContain('event = "SessionEnd"');
      expect(written).toContain('command = "context-mode hook kimi pretooluse"');
      expect(written).toContain('command = "context-mode hook kimi sessionend"');
      expect(written).toContain('matcher = "');
    });

    it("preserves unrelated [[hooks]] entries while updating managed ones", () => {
      const initial = `
[something]
key = "value"

[[hooks]]
event = "PreToolUse"
matcher = ""
command = "node /tmp/some-other-hook.mjs"

[[hooks]]
event = "PostToolUse"
command = "context-mode hook kimi posttooluse"
`;
      mkdirSync(kimiDir, { recursive: true });
      writeFileSync(configPath, initial.trim(), "utf-8");

      adapter.configureAllHooks("/ignored/plugin/root");

      const written = readFileSync(configPath, "utf-8");
      // The old non-managed PreToolUse hook should be preserved
      expect(written).toContain('command = "node /tmp/some-other-hook.mjs"');
      // The managed PostToolUse should be updated/replaced
      expect(written).toContain('event = "PostToolUse"');
      // All 7 expected managed hooks should exist
      expect(written).toContain('event = "SessionEnd"');
      expect(written).toContain('event = "PreCompact"');
      expect(written).toContain('event = "UserPromptSubmit"');
      expect(written).toContain('event = "Stop"');
    });

    it("creates ~/.kimi-code/config.toml when the parent directory is missing", () => {
      rmSync(kimiDir, { recursive: true, force: true });

      adapter.configureAllHooks("/ignored/plugin/root");

      expect(existsSync(configPath)).toBe(true);
      const written = readFileSync(configPath, "utf-8");
      expect(written).toContain('event = "PreToolUse"');
      expect(written).toContain('event = "SessionEnd"');
    });

    it("updates rather than duplicates when called twice", () => {
      adapter.configureAllHooks("/ignored/plugin/root");
      adapter.configureAllHooks("/ignored/plugin/root");

      const written = readFileSync(configPath, "utf-8");
      const hookCount = (written.match(/\[\[hooks\]\]/g) ?? []).length;
      // Should have exactly 7 managed hooks (no duplicates)
      expect(hookCount).toBe(7);
    });
  });

  // ── validateHooks ─────────────────────────────────────

  describe("validateHooks", () => {
    const configPath = join(homedir(), ".kimi-code", "config.toml");
    const kimiDir = join(homedir(), ".kimi-code");

    beforeEach(() => {
      rmSync(kimiDir, { recursive: true, force: true });
    });

    it("fails when config.toml is missing", () => {
      const results = adapter.validateHooks("/ignored/plugin/root");
      expect(results.some((result) => result.status === "fail" && result.check === "Hooks config")).toBe(true);
    });

    it("passes when all required Kimi hooks are configured", () => {
      adapter.configureAllHooks("/ignored/plugin/root");
      const results = adapter.validateHooks("/ignored/plugin/root");
      const configChecks = results.filter((r) => r.check !== "Kimi Code CLI binary");
      expect(configChecks.every((result) => result.status === "pass")).toBe(true);
      expect(results.map((result) => result.check)).toContain("SessionEnd hook");
      expect(results.map((result) => result.check)).toContain("PreCompact hook");
      expect(results.map((result) => result.check)).toContain("Stop hook");
    });

    it("warns instead of failing when only PreCompact is missing", () => {
      const toml = `
[[hooks]]
event = "PreToolUse"
command = "context-mode hook kimi pretooluse"
matcher = "Bash"

[[hooks]]
event = "PostToolUse"
command = "context-mode hook kimi posttooluse"
`;
      mkdirSync(kimiDir, { recursive: true });
      writeFileSync(configPath, toml.trim(), "utf-8");

      const results = adapter.validateHooks("/ignored/plugin/root");
      const precompact = results.find((result) => result.check === "PreCompact hook");
      expect(precompact?.status).toBe("warn");
    });

    it("warns when duplicate context-mode entries exist for the same hook event", () => {
      const toml = `
[[hooks]]
event = "PreToolUse"
matcher = ""
command = "context-mode hook kimi pretooluse"

[[hooks]]
event = "PreToolUse"
matcher = ""
command = "context-mode hook kimi pretooluse"

[[hooks]]
event = "PostToolUse"
command = "context-mode hook kimi posttooluse"
`;
      mkdirSync(kimiDir, { recursive: true });
      writeFileSync(configPath, toml.trim(), "utf-8");

      const results = adapter.validateHooks("/ignored/plugin/root");
      const preToolDup = results.find((r) => r.check === "PreToolUse duplicates");
      expect(preToolDup?.status).toBe("warn");
      expect(preToolDup?.message).toMatch(/2 context-mode entries/);

      // Events with only one context-mode entry must NOT trigger duplicate warning.
      expect(results.some((r) => r.check === "PostToolUse duplicates")).toBe(false);
    });
  });

  // ── checkPluginRegistration ───────────────────────────

  describe("checkPluginRegistration", () => {
    const mcpPath = join(homedir(), ".kimi-code", "mcp.json");
    const kimiDir = join(homedir(), ".kimi-code");

    beforeEach(() => {
      rmSync(kimiDir, { recursive: true, force: true });
    });

    it("passes when context-mode is in mcp.json", () => {
      mkdirSync(kimiDir, { recursive: true });
      writeFileSync(mcpPath, JSON.stringify({
        mcpServers: { "context-mode": { command: "context-mode", args: [] } },
      }, null, 2), "utf-8");

      const result = adapter.checkPluginRegistration();
      expect(result.status).toBe("pass");
      expect(result.message).toContain("context-mode found in mcp.json");
    });

    it("fails when mcpServers exists but context-mode is missing", () => {
      mkdirSync(kimiDir, { recursive: true });
      writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: {} } }, null, 2), "utf-8");

      const result = adapter.checkPluginRegistration();
      expect(result.status).toBe("fail");
      expect(result.message).toContain("context-mode not found");
    });

    it("fails when mcp.json has no mcpServers section", () => {
      mkdirSync(kimiDir, { recursive: true });
      writeFileSync(mcpPath, JSON.stringify({ other: {} }, null, 2), "utf-8");

      const result = adapter.checkPluginRegistration();
      expect(result.status).toBe("fail");
      expect(result.message).toContain("No mcpServers section");
    });

    it("warns when mcp.json cannot be read", () => {
      const result = adapter.checkPluginRegistration();
      expect(result.status).toBe("warn");
      expect(result.message).toContain("Could not read");
    });
  });

  // ── Config / session paths ────────────────────────────

  describe("path resolution", () => {
    it("getConfigDir returns ~/.kimi-code by default", () => {
      expect(adapter.getConfigDir()).toBe(join(homedir(), ".kimi-code"));
    });

    it("getConfigDir honours KIMI_CODE_HOME", () => {
      const saved = process.env.KIMI_CODE_HOME;
      // Use a POSIX-style path on POSIX, a drive-rooted path on Windows.
      // Hardcoding "/custom/kimi" makes the assertion fail on Windows
      // because node:path resolves drive-relative paths against cwd.
      const customDir = process.platform === "win32" ? "C:\\custom\\kimi" : "/custom/kimi";
      process.env.KIMI_CODE_HOME = customDir;
      try {
        expect(adapter.getConfigDir()).toBe(customDir);
      } finally {
        if (saved === undefined) delete process.env.KIMI_CODE_HOME;
        else process.env.KIMI_CODE_HOME = saved;
      }
    });

    it("getSettingsPath returns config.toml under config dir", () => {
      expect(adapter.getSettingsPath()).toBe(join(homedir(), ".kimi-code", "config.toml"));
    });

    it("getMcpPath returns mcp.json under config dir", () => {
      expect(adapter.getMcpPath()).toBe(join(homedir(), ".kimi-code", "mcp.json"));
    });

    it("session dir is under ~/.kimi-code/context-mode/sessions", () => {
      const dir = adapter.getSessionDir();
      // Use path.sep — `resolve("/")` returns the cwd's drive root on Windows
      // (e.g. "D:\\"), producing a nonsense expected string like
      // ".kimi-codeD:\\context-modeD:\\sessions".
      expect(dir).toContain(`.kimi-code${sep}context-mode${sep}sessions`);
    });
  });

  // ── Session DB integration ────────────────────────────

  describe("session DB integration", () => {
    it("stores sessions in platform-specific directory", () => {
      const dir = adapter.getSessionDir();
      expect(dir).toContain(".kimi-code");
    });

    it("resolveSessionDbPath honours getSessionDir", () => {
      const dbPath = resolveSessionDbPath({
        sessionsDir: adapter.getSessionDir(),
        projectDir: "/tmp/project",
      });
      expect(dbPath).toContain(".kimi-code");
    });

    it("can create and write to a SessionDB in the Kimi session dir", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "kimi-adapter-test-"));
      const dbPath = join(tmpDir, "sessions.db");
      mkdirSync(tmpDir, { recursive: true });

      const db = new SessionDB({ dbPath });
      db.ensureSession("sess-kimi-1", "/tmp/proj");
      db.insertEvent("sess-kimi-1", {
        type: "user_prompt",
        category: "user-prompt",
        data: "hello",
        priority: 1,
      });

      const events = db.getEvents("sess-kimi-1");
      expect(events.length).toBeGreaterThanOrEqual(1);
      db.close();

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // ── getInstructionFiles ───────────────────────────────

  it("returns AGENTS.md and AGENTS.override.md as instruction files", () => {
    expect(adapter.getInstructionFiles()).toEqual(["AGENTS.md", "AGENTS.override.md"]);
  });

  // ── getInstalledVersion ───────────────────────────────

  it("returns standalone for getInstalledVersion", () => {
    expect(adapter.getInstalledVersion()).toBe("standalone");
  });
});

// ── Hook script integration tests ──────────────────────

describe("Kimi pretooluse hook script", () => {
  // MCP readiness sentinel — routing.mjs::mcpRedirect bails to null when
  // isMCPReady() returns false, which collapses deny responses into the
  // empty-passthrough default. Hook subprocesses scan sentinelDir() for
  // context-mode-mcp-ready-<PID> files and probe each PID for liveness;
  // writing one keyed to this test's PID satisfies that contract.
  // Mirrors the pattern at tests/hooks/cursor-hooks.test.ts:67-70.
  const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
  const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);
  beforeEach(() => { writeFileSync(mcpSentinel, String(process.pid)); });
  afterEach(() => { try { unlinkSync(mcpSentinel); } catch {} });

  it("outputs valid JSON with hookEventName even for passthrough (no routing match)", () => {
    const hookScript = resolve(__dirname, "../../hooks/kimi/pretooluse.mjs");
    const input = JSON.stringify({
      tool_name: "Read",
      tool_input: { path: "/etc/hosts" },
      session_id: "sess-1",
      cwd: "/tmp",
    });
    const output = execFileSync(process.execPath, [hookScript], {
      input,
      encoding: "utf-8",
      timeout: 5000,
    });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("hookSpecificOutput");
    expect(parsed.hookSpecificOutput).toHaveProperty("hookEventName", "PreToolUse");
  });

  it("blocks WebFetch via deny response", () => {
    // WebFetch is routed to "deny"; Bash+curl is routed to "modify" which
    // is silently dropped by Kimi's deny-only runner.
    const hookScript = resolve(__dirname, "../../hooks/kimi/pretooluse.mjs");
    const input = JSON.stringify({
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com" },
      session_id: "sess-2",
      cwd: "/tmp",
    });
    const output = execFileSync(process.execPath, [hookScript], {
      input,
      encoding: "utf-8",
      timeout: 5000,
    });
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
