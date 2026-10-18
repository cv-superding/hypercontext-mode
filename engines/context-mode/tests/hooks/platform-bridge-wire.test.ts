/**
 * PRD-context-as-a-service §5.2 — Forwarder injection point.
 *
 * Verifies that hooks/session-loaders.mjs::attributeAndInsertEvents wires
 * platform-bridge.mjs::maybeForward correctly:
 *  1. With valid platform.json, every event triggers one POST (wire works).
 *  2. Without platform.json, the loop is skipped entirely — no fetch,
 *     no per-event readFileSync (negative-cache invariant).
 *  3. After 60s TTL, a deleted platform.json eventually halts forwarding
 *     (TTL invalidation).
 */

import { describe, test, beforeEach, afterEach, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

interface MockDb {
  getSessionStats: () => { project_dir?: string } | null;
  getLatestAttributedProjectDir: () => string | null;
  bulkInsertEvents: ReturnType<typeof vi.fn>;
}

function makeMockDb(): MockDb {
  return {
    getSessionStats: () => null,
    getLatestAttributedProjectDir: () => null,
    bulkInsertEvents: vi.fn(),
  };
}

function makeEvents(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    type: "tool_use",
    category: "edit",
    data: `event-${i}`,
  }));
}

function platformConfigFile(fakeHome: string): string {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(fakeHome, "AppData", "Roaming"),
      "context-mode",
      "platform.json",
    );
  }
  return join(fakeHome, ".context-mode", "platform.json");
}

function writePlatformConfig(fakeHome: string, config: Record<string, unknown>): string {
  const cfgFile = platformConfigFile(fakeHome);
  mkdirSync(dirname(cfgFile), { recursive: true });
  writeFileSync(cfgFile, JSON.stringify(config));
  return cfgFile;
}

const resolveAttribs = (evs: { type: string }[]) =>
  evs.map(() => ({ project_dir: "/tmp/p", project_hash: "abc" }));

async function importFresh() {
  vi.resetModules();
  const bridge = await import("../../hooks/platform-bridge.mjs");
  const loaders = await import("../../hooks/session-loaders.mjs");
  return { bridge, loaders };
}

describe("platform-bridge wire — session-loaders forwards events", () => {
  let fakeHome: string;
  let origHome: string | undefined;
  let origXdg: string | undefined;
  let origAppData: string | undefined;
  let origClaudeSessionId: string | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "ctx-bridge-wire-"));
    origHome = process.env.HOME;
    origXdg = process.env.XDG_CONFIG_HOME;
    origAppData = process.env.APPDATA;
    origClaudeSessionId = process.env.CLAUDE_SESSION_ID;
    process.env.HOME = fakeHome;
    delete process.env.XDG_CONFIG_HOME;
    process.env.APPDATA = join(fakeHome, "AppData", "Roaming");
    process.env.CLAUDE_SESSION_ID = "platform-bridge-test";
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
    else delete process.env.XDG_CONFIG_HOME;
    if (origAppData !== undefined) process.env.APPDATA = origAppData;
    else delete process.env.APPDATA;
    if (origClaudeSessionId !== undefined) process.env.CLAUDE_SESSION_ID = origClaudeSessionId;
    else delete process.env.CLAUDE_SESSION_ID;
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {}
    vi.useRealTimers();
    vi.doUnmock("../../hooks/platform-bridge.mjs");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("with NO platform.json, loop is gated — maybeForward never called", async () => {
    vi.resetModules();
    vi.doMock("../../hooks/platform-bridge.mjs", () => ({
      maybeForward: vi.fn(),
      hasPlatformConfig: vi.fn(() => false),
      configPath: vi.fn(),
      buildUrl: vi.fn(),
      sanitizeEvent: vi.fn(),
    }));

    const bridge = await import("../../hooks/platform-bridge.mjs");
    const { attributeAndInsertEvents } = await import("../../hooks/session-loaders.mjs");

    const db = makeMockDb();
    attributeAndInsertEvents(
      db,
      "session-test",
      makeEvents(30),
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      resolveAttribs,
    );

    expect(bridge.hasPlatformConfig).toHaveBeenCalledTimes(1);
    expect(bridge.maybeForward).not.toHaveBeenCalled();

    vi.doUnmock("../../hooks/platform-bridge.mjs");
  });

  test("no platform.json + many calls: FS probed at most once per TTL window", async () => {
    // No platform.json written — HOME points at a fresh empty temp dir.
    const { loaders, bridge } = await importFresh();
    bridge._internal.resetState();

    const db = makeMockDb();
    for (let n = 0; n < 5; n++) {
      loaders.attributeAndInsertEvents(
        db,
        `session-${n}`,
        makeEvents(10),
        { workspace_roots: ["/tmp/p"] },
        "/tmp/p",
        "PostToolUse",
        resolveAttribs,
      );
    }

    expect(bridge._internal.fsLoads).toBe(1);
  });

  test("TTL invalidation: platform.json removed mid-session halts forwarding after TTL", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));

    const cfgFile = writePlatformConfig(
      fakeHome,
      {
        api_key: "ctxm_ttl_test",
        platform_url: "https://example.test/api/v1",
      },
    );

    const { loaders, bridge } = await importFresh();
    bridge._internal.resetState();

    const db = makeMockDb();

    loaders.attributeAndInsertEvents(
      db,
      "session-before",
      makeEvents(2),
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      resolveAttribs,
    );
    await vi.advanceTimersByTimeAsync(10);

    const beforeRemove = fetchSpy.mock.calls.length;
    expect(beforeRemove).toBe(2);

    rmSync(cfgFile);
    vi.advanceTimersByTime(61_000);

    loaders.attributeAndInsertEvents(
      db,
      "session-after",
      makeEvents(2),
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      resolveAttribs,
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(fetchSpy.mock.calls.length).toBe(beforeRemove);

    vi.useRealTimers();
  });

  test("with valid platform.json, N events triggers N fetch calls", async () => {
    writePlatformConfig(
      fakeHome,
      {
        api_key: "ctxm_wire_test",
        platform_url: "https://example.test/api/v1",
      },
    );

    const { loaders } = await importFresh();
    const db = makeMockDb();
    const events = makeEvents(3);

    loaders.attributeAndInsertEvents(
      db,
      "session-test",
      events,
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      resolveAttribs,
    );

    // Wait for fire-and-forget POSTs to flush
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(db.bulkInsertEvents).toHaveBeenCalledTimes(1);
  });

  test("project attribution: attributions[i].projectDir flows into POST body (sanitized)", async () => {
    writePlatformConfig(
      fakeHome,
      {
        api_key: "ctxm_proj_test",
        platform_url: "https://example.test/api/v1",
      },
    );

    const { loaders } = await importFresh();
    const db = makeMockDb();

    // Real resolveProjectAttributions returns objects with camelCase `projectDir`
    // (see src/session/project-attribution.ts:55). The wire must surface that
    // into the POST body so the platform can group events per project.
    const resolveWithProjectDir = (evs: { type: string }[]) =>
      evs.map(() => ({ projectDir: "/Users/realuser/myproj" }));

    loaders.attributeAndInsertEvents(
      db,
      "session-proj",
      makeEvents(1),
      { workspace_roots: ["/Users/realuser/myproj"] },
      "/Users/realuser/myproj",
      "PostToolUse",
      resolveWithProjectDir,
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    // Project field MUST be populated (not undefined / null / empty)
    expect(body.project).toBeTruthy();
    // Privacy: username MUST be normalized away
    expect(body.project).not.toContain("realuser");
    // Identity: project basename MUST survive
    expect(body.project).toContain("myproj");
  });

  test("envelope ABI: unknown event fields passthrough to body unchanged", async () => {
    writePlatformConfig(
      fakeHome,
      {
        api_key: "ctxm_envelope_test",
        platform_url: "https://example.test/api/v1",
      },
    );

    const { loaders } = await importFresh();
    const db = makeMockDb();

    // Simulate a FUTURE event type that ships brand-new fields the bridge has
    // never seen. The envelope MUST pass them straight through to the platform
    // so adding new fields never requires a bridge release (PRD §5.4 ABI).
    const futureEvent = {
      type: "future_event_type",
      category: "future_cat",
      data: "payload",
      brand_new_field: "should-passthrough",
      nested: { deep: "value" },
      array_field: [1, 2, 3],
    };

    loaders.attributeAndInsertEvents(
      db,
      "sid",
      [futureEvent],
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      (evs: { type: string }[]) => evs.map(() => ({ projectDir: "/tmp/p" })),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);

    // Envelope metadata
    expect(body.platform).toBe("claude-code");
    expect(typeof body.ts).toBe("number");

    // Canonical event fields
    expect(body.type).toBe("future_event_type");
    expect(body.category).toBe("future_cat");
    expect(body.session_id).toBe("sid");

    // Future passthrough — this is the load-bearing invariant.
    expect(body.brand_new_field).toBe("should-passthrough");
    expect(body.nested).toEqual({ deep: "value" });
    expect(body.array_field).toEqual([1, 2, 3]);

    // Anti-regression: legacy hand-mapped fields MUST NOT reappear
    // (server reads canonical names now; hand-mapping was the smell).
    // Anti-regression: legacy hand-mapped `tool` field MUST NOT reappear —
    // canonical name is `type` post-v1.0.156 envelope refactor.
    expect(body).not.toHaveProperty("tool");
    // v1.0.158 seed-parity fields ARE expected to surface — these were the
    // anti-regression assertions of the envelope refactor, but session-loaders
    // now legitimately derives them from per-event facts. Update them to be
    // POSITIVE: confirm the platform receives the seed-shape stamps.
    expect(body).toHaveProperty("session_type");
    expect(body).toHaveProperty("session_category");
    expect(body).toHaveProperty("error");
  });

  test("savings: positive bytes_avoided is forwarded for the platform P&L", async () => {
    writePlatformConfig(
      fakeHome,
      { api_key: "ctxm_savings_test", platform_url: "https://example.test/api/v1" },
    );

    const { loaders } = await importFresh();
    const db = makeMockDb();

    // A redirect event that kept 8000 bytes out of the context window — the
    // context-saving "profit" signal the platform FinOps P&L sums into savings.
    const redirectEvent = {
      type: "redirect",
      category: "redirect",
      data: "curl https://example.com",
      bytes_avoided: 8000,
    };

    loaders.attributeAndInsertEvents(
      db,
      "sid",
      [redirectEvent],
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      (evs: { type: string }[]) => evs.map(() => ({ projectDir: "/tmp/p" })),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.bytes_avoided).toBe(8000);
  });

  test("retrieval: positive bytes_retrieved is forwarded for the with/without ratio", async () => {
    writePlatformConfig(
      fakeHome,
      { api_key: "ctxm_retrieval_test", platform_url: "https://example.test/api/v1" },
    );

    const { loaders } = await importFresh();
    const db = makeMockDb();

    // A ctx_search call whose 4200-byte tool_response is the kept-out content
    // the model PAID to access — the OTHER half of the with/without ratio.
    const retrievalEvent = {
      type: "mcp_tool_call",
      category: "mcp_tool_call",
      data: '{"tool_name":"mcp__plugin_context-mode_context-mode__ctx_search"}',
      bytes_retrieved: 4200,
    };

    loaders.attributeAndInsertEvents(
      db,
      "sid",
      [retrievalEvent],
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      (evs: { type: string }[]) => evs.map(() => ({ projectDir: "/tmp/p" })),
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.bytes_retrieved).toBe(4200);
  });
});

// ─────────────────────────────────────────────────────────
// Project identity resolution
// ─────────────────────────────────────────────────────────
describe("platform-bridge — project identity resolution", () => {
  describe("normalizeRemoteUrl", () => {
    test.each([
      ["git@github.com:mksglu/context-mode.git", "github.com/mksglu/context-mode"],
      ["https://github.com/mksglu/context-mode.git", "github.com/mksglu/context-mode"],
      ["https://github.com/mksglu/context-mode", "github.com/mksglu/context-mode"],
      ["https://oauth2:TOKEN@github.com/mksglu/private.git", "github.com/mksglu/private"],
      ["ssh://git@gitlab.example.com/org/sub/repo.git", "gitlab.example.com/org/sub/repo"],
      // SSH with port-style host: not real ssh URI, but tolerate gracefully
      ["git@GitHub.COM:Mksglu/Repo.git", "github.com/Mksglu/Repo"],
    ])("%s → %s", async (input, expected) => {
      const { bridge } = await importFresh();
      expect(bridge._internal.normalizeRemoteUrl(input)).toBe(expected);
    });
  });

  describe("resolveProjectIdentity", () => {
    let scratchRoot: string;

    beforeEach(() => {
      scratchRoot = mkdtempSync(join(tmpdir(), "ctx-project-identity-"));
    });
    afterEach(() => {
      try { rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
    });

    test("worktree dedup: two worktrees of the same repo collapse to one identity", async () => {
      const repo = join(scratchRoot, "repo");
      mkdirSync(repo);
      execSync(`git init -q && git remote add origin git@github.com:acme/myrepo.git`, {
        cwd: repo,
        stdio: "ignore",
      });

      // Same .git → linked worktrees share remote config. Simulate by
      // pointing two directories' .git files at the same gitdir.
      const wt1 = join(scratchRoot, "wt1");
      const wt2 = join(scratchRoot, "wt2");
      mkdirSync(wt1);
      mkdirSync(wt2);
      writeFileSync(join(wt1, ".git"), `gitdir: ${repo}/.git\n`);
      writeFileSync(join(wt2, ".git"), `gitdir: ${repo}/.git\n`);

      const { bridge } = await importFresh();
      bridge._internal.resetState();

      const id1 = bridge._internal.resolveProjectIdentity(wt1);
      const id2 = bridge._internal.resolveProjectIdentity(wt2);
      const idMain = bridge._internal.resolveProjectIdentity(repo);

      expect(id1).toBe("github.com/acme/myrepo");
      expect(id2).toBe("github.com/acme/myrepo");
      expect(idMain).toBe("github.com/acme/myrepo");
    });

    test("monorepo sub-package: deeper package.json wins over git remote URL", async () => {
      const root = join(scratchRoot, "mono");
      const subPkg = join(root, "packages", "api");
      mkdirSync(subPkg, { recursive: true });
      execSync(`git init -q && git remote add origin https://github.com/acme/mono.git`, {
        cwd: root,
        stdio: "ignore",
      });
      // Root workspace package.json (umbrella name)
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mono-root" }));
      // Sub-package — deeper than .git → wins
      writeFileSync(join(subPkg, "package.json"), JSON.stringify({ name: "@acme/api" }));

      const { bridge } = await importFresh();
      bridge._internal.resetState();

      expect(bridge._internal.resolveProjectIdentity(subPkg)).toBe("@acme/api");
      expect(bridge._internal.resolveProjectIdentity(root)).toBe("github.com/acme/mono");
    });

    test("local-only project (no git, has package.json): package name wins", async () => {
      const dir = join(scratchRoot, "local");
      mkdirSync(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "scratch-toy" }));

      const { bridge } = await importFresh();
      bridge._internal.resetState();
      expect(bridge._internal.resolveProjectIdentity(dir)).toBe("scratch-toy");
    });

    test("no git + no package.json: basename fallback", async () => {
      const dir = join(scratchRoot, "naked-dir-xyz");
      mkdirSync(dir);

      const { bridge } = await importFresh();
      bridge._internal.resetState();
      expect(bridge._internal.resolveProjectIdentity(dir)).toBe("naked-dir-xyz");
    });

    test("cache: second resolution for same dir uses cache (no re-walk)", async () => {
      const dir = join(scratchRoot, "cached");
      mkdirSync(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cache-pkg" }));

      const { bridge } = await importFresh();
      bridge._internal.resetState();

      expect(bridge._internal.projectIdentityCacheSize).toBe(0);
      bridge._internal.resolveProjectIdentity(dir);
      expect(bridge._internal.projectIdentityCacheSize).toBe(1);
      bridge._internal.resolveProjectIdentity(dir);
      // Same dir → no new entry.
      expect(bridge._internal.projectIdentityCacheSize).toBe(1);
    });
  });

  describe("integration: session-loaders → maybeForward → resolved project", () => {
    let scratchRoot: string;
    let fakeHome: string;
    let origHome: string | undefined;
    let origXdg: string | undefined;
    let origAppData: string | undefined;
    let origClaudeSessionId: string | undefined;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      scratchRoot = mkdtempSync(join(tmpdir(), "ctx-bridge-integration-"));
      fakeHome = mkdtempSync(join(tmpdir(), "ctx-bridge-integration-home-"));
      origHome = process.env.HOME;
      origXdg = process.env.XDG_CONFIG_HOME;
      origAppData = process.env.APPDATA;
      origClaudeSessionId = process.env.CLAUDE_SESSION_ID;
      process.env.HOME = fakeHome;
      delete process.env.XDG_CONFIG_HOME;
      process.env.APPDATA = join(fakeHome, "AppData", "Roaming");
      process.env.CLAUDE_SESSION_ID = "platform-bridge-test";
      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 200 }),
      );
    });

    afterEach(() => {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
      else delete process.env.XDG_CONFIG_HOME;
      if (origAppData !== undefined) process.env.APPDATA = origAppData;
      else delete process.env.APPDATA;
      if (origClaudeSessionId !== undefined) process.env.CLAUDE_SESSION_ID = origClaudeSessionId;
      else delete process.env.CLAUDE_SESSION_ID;
      try { rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
      try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
      vi.useRealTimers();
      vi.doUnmock("../../hooks/platform-bridge.mjs");
      vi.resetModules();
      vi.restoreAllMocks();
    });

    test("worktree path on the wire becomes the canonical remote URL", async () => {
      const repo = join(scratchRoot, "repo");
      mkdirSync(repo);
      execSync(`git init -q && git remote add origin git@github.com:mksglu/context-mode.git`, {
        cwd: repo,
        stdio: "ignore",
      });

      writePlatformConfig(
        fakeHome,
        {
          api_key: "ctxm_resolve_test",
          platform_url: "https://example.test/api/v1",
        },
      );

      const { loaders } = await importFresh();
      const db = makeMockDb();

      // Attribution returns the worktree path — bridge MUST canonicalize.
      const attribsAtWorktree = (evs: { type: string }[]) =>
        evs.map(() => ({ projectDir: repo }));

      loaders.attributeAndInsertEvents(
        db,
        "s",
        [{ type: "tool_use", category: "edit", data: "x" }],
        { workspace_roots: [repo] },
        repo,
        "PostToolUse",
        attribsAtWorktree,
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(fetchSpy).toHaveBeenCalled();
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
      expect(body.project).toBe("github.com/mksglu/context-mode");
    });
  });
});
