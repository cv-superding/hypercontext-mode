import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyProfilePreset,
  buildPolicy,
  defaultConfig,
  getHypercontextPaths,
  prepareRuntime,
  resolveMcpToolset,
  resolveSessionIdentity,
  type Profile,
} from "@hypercontext/core";
import { buildMeter } from "@hypercontext/runtime";
import type { ProxyOverview } from "@hypercontext/runtime";

async function withHome<T>(prefix: string, run: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const previous = process.env.HYPERCONTEXT_HOME;
  process.env.HYPERCONTEXT_HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.HYPERCONTEXT_HOME;
    else process.env.HYPERCONTEXT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("profile presets switch layers, memory and the MCP surface explicitly", async () => {
  await withHome("hctx-profile-", async () => {
    const config = defaultConfig();
    assert.equal(config.profile, "balanced");
    assert.equal(resolveMcpToolset(config), "lean");

    applyProfilePreset(config, "lean");
    assert.equal(config.profile, "lean");
    assert.equal(config.sandbox.enabled, true);
    assert.equal(config.compression.enabled, false);
    assert.equal(config.sandbox.memoryInjection, "full");
    assert.equal(config.mcp.toolset, "lean");
    assert.equal(resolveMcpToolset(config), "lean");

    applyProfilePreset(config, "balanced");
    assert.equal(config.compression.enabled, true);
    assert.equal(config.compression.mode, "cooperative");
    assert.equal(config.sandbox.memoryInjection, "auto");
    assert.equal(resolveMcpToolset(config), "lean");

    applyProfilePreset(config, "maximum");
    assert.equal(config.compression.enabled, true);
    assert.equal(config.sandbox.memoryInjection, "minimal");
    assert.equal(config.mcp.toolset, "full");
    assert.equal(resolveMcpToolset(config), "full");
  });
});

test("balanced profile switches to auto-fold only when a summary provider exists", async () => {
  await withHome("hctx-profile-summary-", async () => {
    const config = defaultConfig();
    config.compression.summary = {
      baseUrl: "https://summary.example/v1",
      api: "openai",
      apiKeyEnv: "SUMMARY_API_KEY",
      model: "cheap-summary",
      autoFoldTargetTokens: 40000,
    };
    applyProfilePreset(config, "balanced");
    assert.equal(config.compression.mode, "autofold");
  });
});

test("an explicit MCP toolset always wins over the profile default", async () => {
  await withHome("hctx-toolset-", async () => {
    const config = defaultConfig();
    config.profile = "maximum";
    config.mcp.toolset = "auto";
    assert.equal(resolveMcpToolset(config), "full");
    config.mcp.toolset = "lean";
    assert.equal(resolveMcpToolset(config), "lean");
    config.mcp.toolset = "full";
    assert.equal(resolveMcpToolset(config), "full");
  });
});

test("policy exposes the profile, the cold-start gate and the MCP toolset", async () => {
  await withHome("hctx-policy-new-", async () => {
    const config = defaultConfig();
    config.profile = "maximum";
    config.compression.coldStartTokens = 48000;
    const policy = buildPolicy({ config });
    assert.equal(policy.profile, "maximum");
    assert.equal(policy.coldStartTokens, 48000);
    assert.equal(policy.mcpToolset, "full");
    assert.equal(policy.env.ACP_INJECT_AFTER_TOKENS, "48000");
    assert.equal(policy.env.HYPERCONTEXT_COMPRESSION_MODE, "cooperative");
  });
});

test("policy warns when auto-fold has no resolvable summary credential", async () => {
  await withHome("hctx-policy-warn-", async () => {
    const config = defaultConfig();
    config.compression.mode = "autofold";
    config.compression.summary = {
      baseUrl: "https://summary.example/v1",
      api: "openai",
      apiKeyEnv: "HCTX_MISSING_SUMMARY_KEY",
      model: "cheap-summary",
      autoFoldTargetTokens: 40000,
    };
    const previous = process.env.HCTX_MISSING_SUMMARY_KEY;
    delete process.env.HCTX_MISSING_SUMMARY_KEY;
    try {
      const policy = buildPolicy({ config });
      assert.ok(policy.warnings.some((warning) => warning.includes("HCTX_MISSING_SUMMARY_KEY")));
    } finally {
      if (previous !== undefined) process.env.HCTX_MISSING_SUMMARY_KEY = previous;
    }
  });
});

function overview(overrides: Partial<ProxyOverview> = {}): ProxyOverview {
  return {
    sessions: 1,
    live: 1,
    requests: 10,
    inputTokens: 1000,
    cachedTokens: 0,
    outputTokens: 100,
    tokensSaved: 0,
    hitPct: null,
    blocks: 1,
    grossSaved: 0,
    netSaved: 0,
    repay: 0,
    summaryCost: 0,
    summaryInputTokens: 0,
    summaryOutputTokens: 0,
    summaryCalls: 0,
    summaryLatencyMs: 0,
    injectedOverheadTokens: 0,
    postFoldRequests: 0,
    hasFoldData: false,
    ...overrides,
  };
}

test("net meter subtracts summary and injection overhead from gross savings", async () => {
  await withHome("hctx-meter-", async () => {
    const config = defaultConfig();
    const meter = buildMeter(
      overview({
        grossSaved: 1000,
        netSaved: 850,
        repay: 100,
        summaryCost: 50,
        summaryInputTokens: 200,
        summaryOutputTokens: 50,
        summaryCalls: 4,
        summaryLatencyMs: 400,
        injectedOverheadTokens: 100,
        postFoldRequests: 10,
        hasFoldData: true,
      }),
      config,
    );
    assert.equal(meter.tokens.netAfterOverhead, 550);
    assert.equal(meter.requests.grossPerPostFoldRequest, 100);
    assert.equal(meter.requests.breakEvenPostFoldRequests, 0);
    assert.equal(meter.summary.averageLatencyMs, 100);
    assert.equal(meter.money.configured, false);
  });
});

test("net meter reports the break-even turn count while the overhead is still unearned", async () => {
  await withHome("hctx-meter-breakeven-", async () => {
    const config = defaultConfig();
    const meter = buildMeter(
      overview({
        grossSaved: 100,
        netSaved: -50,
        repay: 100,
        summaryCost: 0,
        summaryInputTokens: 0,
        injectedOverheadTokens: 50,
        postFoldRequests: 10,
        hasFoldData: true,
      }),
      config,
    );
    assert.equal(meter.tokens.netAfterOverhead, -50);
    assert.equal(meter.requests.breakEvenPostFoldRequests, 15);
  });
});

test("net meter prices tokens only when a rate is configured", async () => {
  await withHome("hctx-meter-price-", async () => {
    const config = defaultConfig();
    config.pricing.inputPerMTok = 3;
    config.pricing.cachedInputPerMTok = 0.3;
    config.pricing.outputPerMTok = 15;
    config.pricing.summaryInputPerMTok = 0.5;
    config.pricing.summaryOutputPerMTok = 2;
    const meter = buildMeter(
      overview({
        grossSaved: 1_000_000,
        repay: 100_000,
        summaryCost: 50_000,
        summaryInputTokens: 200_000,
        summaryOutputTokens: 50_000,
        injectedOverheadTokens: 100_000,
        postFoldRequests: 5,
        hasFoldData: true,
      }),
      config,
    );
    assert.equal(meter.money.configured, true);
    assert.equal(Math.round(meter.money.saved * 100) / 100, 3);
    assert.equal(Math.round(meter.money.repay * 100) / 100, 0.3);
    assert.equal(Math.round(meter.money.summary * 100) / 100, 0.2);
    assert.equal(Math.round(meter.money.injected * 100) / 100, 0.03);
    assert.equal(Math.round(meter.money.net * 100) / 100, 2.47);
  });
});

function createSessionDb(file: string, projectDir: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_event_at TEXT,
      event_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare("INSERT INTO session_meta (session_id, project_dir, event_count) VALUES (?, ?, 1)").run(
    "s1",
    projectDir,
  );
  db.prepare("INSERT INTO session_events (session_id, type, category, data) VALUES (?, 'decision', 'decision', ?)").run(
    "s1",
    "Needle decision for the joined session.",
  );
  db.prepare("INSERT INTO session_events (session_id, type, category, data) VALUES (?, 'decision', 'decision', ?)").run(
    "s2",
    "Needle decision for another session.",
  );
  db.close();
}

function createCompressionIndex(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, stats_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE content (hash TEXT PRIMARY KEY, byte_len INTEGER NOT NULL, bytes BLOB NOT NULL);
    CREATE TABLE messages (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, msg_id TEXT NOT NULL,
      ref TEXT, role TEXT NOT NULL, content_hash TEXT NOT NULL, PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE blocks (
      block_id TEXT NOT NULL, session_id TEXT NOT NULL, ord INTEGER NOT NULL,
      start_ref INTEGER, end_ref INTEGER, tier INTEGER NOT NULL, summary_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, payload_json TEXT NOT NULL
    );
  `);
  const now = Date.now();
  db.prepare("INSERT INTO sessions (session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
    "s1",
    "joined",
    now,
    now,
  );
  db.prepare("INSERT INTO sessions (session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
    "s2",
    "other",
    now,
    now,
  );
  const joined = Buffer.from("Needle summary for the joined session.");
  const other = Buffer.from("Needle summary for another session.");
  db.prepare("INSERT INTO content (hash, byte_len, bytes) VALUES (?, ?, ?)").run("h1", joined.byteLength, joined);
  db.prepare("INSERT INTO content (hash, byte_len, bytes) VALUES (?, ?, ?)").run("h2", other.byteLength, other);
  db.prepare(
    "INSERT INTO messages (session_id, seq, msg_id, ref, role, content_hash) VALUES (?, 1, 'm1', 'm00001', 'user', 'h1')",
  ).run("s1");
  db.prepare(
    "INSERT INTO messages (session_id, seq, msg_id, ref, role, content_hash) VALUES (?, 1, 'm2', 'm00001', 'user', 'h2')",
  ).run("s2");
  db.prepare(
    "INSERT INTO blocks (block_id, session_id, ord, start_ref, end_ref, tier, summary_hash, active, created_at, payload_json) VALUES (?, ?, 1, 1, 1, 1, ?, 1, ?, '{}')",
  ).run("b1", "s1", "h1", now);
  db.prepare(
    "INSERT INTO blocks (block_id, session_id, ord, start_ref, end_ref, tier, summary_hash, active, created_at, payload_json) VALUES (?, ?, 1, 1, 1, 1, ?, 1, ?, '{}')",
  ).run("b2", "s2", "h2", now);
  db.close();
}

test("session identity joins the two layers on the host's own session id", async () => {
  await withHome("hctx-identity-", async (home) => {
    prepareRuntime(defaultConfig());
    const paths = getHypercontextPaths();
    mkdirSync(paths.contextSessionsDir, { recursive: true });
    mkdirSync(paths.compressionSessionsDir, { recursive: true });
    const projectDir = join(home, "workspace");
    createSessionDb(join(paths.contextSessionsDir, "project.db"), projectDir);
    createCompressionIndex(join(paths.compressionSessionsDir, "index.db"));

    const identity = resolveSessionIdentity({ projectDir });
    assert.equal(identity.sandboxSessionId, "s1");
    assert.equal(identity.matched, true);
    assert.deepEqual(identity.compressionSessionIds.sort(), ["s1", "s2"]);
  });
});

test("federated search narrows to the joined session unless the caller opts out", async () => {
  await withHome("hctx-identity-search-", async (home) => {
    prepareRuntime(defaultConfig());
    const paths = getHypercontextPaths();
    mkdirSync(paths.contextSessionsDir, { recursive: true });
    mkdirSync(paths.compressionSessionsDir, { recursive: true });
    const projectDir = join(home, "workspace");
    createSessionDb(join(paths.contextSessionsDir, "project.db"), projectDir);
    createCompressionIndex(join(paths.compressionSessionsDir, "index.db"));

    const { federatedSearch } = await import("@hypercontext/core");
    const scoped = federatedSearch({ query: "needle", projectDir });
    assert.equal(scoped.diagnostics.sessionId, "s1");
    assert.equal(scoped.diagnostics.compressionSessionMatched, true);
    assert.ok(scoped.hits.length > 0);
    assert.ok(scoped.hits.every((hit) => !hit.sessionId || hit.sessionId === "s1"));

    const wide = federatedSearch({ query: "needle", projectDir, allSessions: true });
    assert.equal(wide.diagnostics.sessionId, undefined);
    assert.ok(wide.hits.some((hit) => hit.sessionId === "s2"));

    const explicit = federatedSearch({ query: "needle", projectDir, sessionId: "s2" });
    assert.ok(explicit.hits.every((hit) => !hit.sessionId || hit.sessionId === "s2"));
  });
});

test("content orphaned by a host-side compaction stays searchable", async () => {
  await withHome("hctx-archived-content-", async () => {
    prepareRuntime(defaultConfig());
    const paths = getHypercontextPaths();
    mkdirSync(paths.compressionSessionsDir, { recursive: true });
    const db = new DatabaseSync(join(paths.compressionSessionsDir, "index.db"));
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, stats_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE content (hash TEXT PRIMARY KEY, byte_len INTEGER NOT NULL, bytes BLOB NOT NULL);
      CREATE TABLE messages (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, msg_id TEXT NOT NULL,
        ref TEXT, ref_num INTEGER, role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message',
        content_hash TEXT NOT NULL, PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE blocks (
        block_id TEXT NOT NULL, session_id TEXT NOT NULL, ord INTEGER NOT NULL,
        start_ref INTEGER, end_ref INTEGER, tier INTEGER NOT NULL, summary_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, payload_json TEXT NOT NULL
      );
    `);
    const live = Buffer.from("live message text about the running conversation");
    const orphan = Buffer.from("ORPHANED-MARKER text the host compaction dropped");
    db.prepare("INSERT INTO sessions (session_id, title, created_at, updated_at) VALUES ('s1', 't', 1, 1)").run();
    db.prepare("INSERT INTO content (hash, byte_len, bytes) VALUES (?, ?, ?)").run("h-live", live.byteLength, live);
    db.prepare("INSERT INTO content (hash, byte_len, bytes) VALUES (?, ?, ?)").run("h-orphan", orphan.byteLength, orphan);
    db.prepare("INSERT INTO messages (session_id, seq, msg_id, ref, role, content_hash) VALUES ('s1', 1, 'm1', 'm00001', 'user', 'h-live')").run();
    db.close();

    const { federatedSearch } = await import("@hypercontext/core");
    const archived = federatedSearch({ query: "ORPHANED-MARKER" });
    assert.equal(archived.hits.length, 1);
    assert.equal(archived.hits[0]?.kind, "compression-archived-content");
    assert.equal(archived.hits[0]?.layer, "compression");

    // Live content must not be reported twice (once as a message, once as an orphan).
    const liveHits = federatedSearch({ query: "live message text" });
    assert.equal(liveHits.hits.length, 1);
    assert.equal(liveHits.hits[0]?.kind, "compression-message");
  });
});
