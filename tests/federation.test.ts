import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  collectStats,
  federatedSearch,
  getHypercontextPaths,
  hashProjectDir,
  prepareRuntime,
  defaultConfig,
} from "@hypercontext/core";

function createContentDb(file: string, label = "src/login.ts", content = "The auth needle lives in the login handler."): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      code_chunk_count INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
      file_path TEXT,
      content_hash TEXT
    );
    CREATE VIRTUAL TABLE chunks USING fts5(
      title, content, source_id UNINDEXED, content_type UNINDEXED,
      source_category UNINDEXED, session_id UNINDEXED, event_id UNINDEXED,
      timestamp UNINDEXED, tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE chunks_trigram USING fts5(
      title, content, source_id UNINDEXED, content_type UNINDEXED,
      source_category UNINDEXED, session_id UNINDEXED, event_id UNINDEXED,
      timestamp UNINDEXED, tokenize='trigram'
    );
  `);
  db.prepare("INSERT INTO sources (label, chunk_count) VALUES (?, ?)").run(label, 1);
  db.prepare(
    "INSERT INTO chunks (title, content, source_id, content_type, source_category, session_id, event_id, timestamp) VALUES (?, ?, 1, 'code', 'file', 's1', '0', '')",
  ).run("login flow", content);
  db.close();
}

function createSessionDb(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 2,
      data TEXT NOT NULL,
      project_dir TEXT NOT NULL DEFAULT '',
      attribution_source TEXT NOT NULL DEFAULT 'unknown',
      attribution_confidence REAL NOT NULL DEFAULT 0,
      bytes_avoided INTEGER NOT NULL DEFAULT 0,
      bytes_returned INTEGER NOT NULL DEFAULT 0,
      source_hook TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      data_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_event_at TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      compact_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tool_calls (
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      bytes_returned INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, tool)
    );
  `);
  db.prepare(
    "INSERT INTO session_events (session_id, type, category, data, source_hook, bytes_avoided) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("s1", "decision", "decision", "We chose the needle retry strategy.", "PostToolUse", 4096);
  db.prepare("INSERT INTO session_meta (session_id, project_dir, event_count) VALUES (?, ?, ?)").run(
    "s1",
    process.cwd(),
    1,
  );
  db.prepare("INSERT INTO tool_calls (session_id, tool, calls) VALUES (?, ?, ?)").run("s1", "Read", 3);
  db.close();
}

function createCompressionIndex(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, parent_session_id TEXT, fork_point_seq INTEGER,
      protocol TEXT, label TEXT, title TEXT, host_title TEXT,
      namespace TEXT NOT NULL DEFAULT 'proxy', origin TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      next_block_id INTEGER NOT NULL DEFAULT 1, next_run_id INTEGER NOT NULL DEFAULT 1,
      meta_json TEXT NOT NULL DEFAULT '{}', stats_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}', kstate_json TEXT NOT NULL DEFAULT '{}',
      tail_json TEXT NOT NULL DEFAULT '{}', ccr_json TEXT, last_ingested_seq INTEGER
    );
    CREATE TABLE content (
      hash TEXT PRIMARY KEY, byte_len INTEGER NOT NULL, refcount INTEGER NOT NULL DEFAULT 0,
      algo TEXT NOT NULL DEFAULT 'sha256', bytes BLOB NOT NULL
    );
    CREATE TABLE messages (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, msg_id TEXT NOT NULL,
      ref TEXT, ref_num INTEGER, role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message',
      content_hash TEXT NOT NULL, PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE blocks (
      block_id TEXT NOT NULL, session_id TEXT NOT NULL, ord INTEGER NOT NULL,
      start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL, start_ref INTEGER, end_ref INTEGER,
      tier INTEGER NOT NULL, summary_hash TEXT NOT NULL, one_hash TEXT,
      supersedes_block_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
      covered_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY (session_id, block_id)
    );
  `);
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (session_id, title, status, created_at, updated_at, stats_json) VALUES (?, ?, 'active', ?, ?, ?)",
  ).run("bs1", "Needle investigation", now, now, JSON.stringify({ requests: 42 }));

  const message = Buffer.from("Please investigate the needle failure in auth.");
  const summary = Buffer.from("Compressed: the needle failure was caused by a retry race.");
  db.prepare("INSERT INTO content (hash, byte_len, bytes) VALUES (?, ?, ?)").run(
    "hash-msg",
    message.byteLength,
    message,
  );
  db.prepare("INSERT INTO content (hash, byte_len, bytes) VALUES (?, ?, ?)").run(
    "hash-sum",
    summary.byteLength,
    summary,
  );
  db.prepare(
    "INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, content_hash) VALUES (?, 1, 'm1', 'm00001', 1, 'user', 'hash-msg')",
  ).run("bs1");
  db.prepare(
    "INSERT INTO blocks (block_id, session_id, ord, start_seq, end_seq, start_ref, end_ref, tier, summary_hash, active, created_at, covered_hash, payload_json) VALUES (?, ?, 1, 1, 1, 1, 1, 1, ?, 1, ?, 'cov', ?)",
  ).run(
    "b1",
    "bs1",
    "hash-sum",
    now,
    JSON.stringify({ topic: "needle retry race", compressedTokens: 1234 }),
  );
  db.close();
}

test("federated search returns hits from both layers and stats aggregate", () => {
  const home = mkdtempSync(join(tmpdir(), "hctx-fed-"));
  const previous = process.env.HYPERCONTEXT_HOME;
  process.env.HYPERCONTEXT_HOME = home;
  try {
    prepareRuntime(defaultConfig());
    const paths = getHypercontextPaths();
    mkdirSync(paths.contextContentDir, { recursive: true });
    mkdirSync(paths.contextSessionsDir, { recursive: true });
    mkdirSync(paths.compressionSessionsDir, { recursive: true });
    createContentDb(join(paths.contextContentDir, "project.db"));
    createSessionDb(join(paths.contextSessionsDir, "project.db"));
    createCompressionIndex(join(paths.compressionSessionsDir, "index.db"));

    const result = federatedSearch({ query: "needle", limit: 10 });
    assert.ok(result.hits.some((hit) => hit.layer === "sandbox" && hit.kind === "content"));
    assert.ok(result.hits.some((hit) => hit.layer === "sandbox" && hit.kind === "session-event"));
    assert.ok(result.hits.some((hit) => hit.layer === "compression" && hit.kind === "compression-summary"));

    const scoped = federatedSearch({ query: "needle", scope: "compression" });
    assert.ok(scoped.hits.length > 0);
    assert.ok(scoped.hits.every((hit) => hit.layer === "compression"));
    assert.ok(scoped.hits.some((hit) => hit.ref === "1-1"));

    const stats = collectStats();
    assert.equal(stats.sandbox.contentDbs, 1);
    assert.equal(stats.sandbox.sessionDbs, 1);
    assert.equal(stats.sandbox.events, 1);
    assert.equal(stats.sandbox.bytesAvoided, 4096);
    assert.equal(stats.compression.indexPresent, true);
    assert.equal(stats.compression.messages, 1);
    assert.equal(stats.compression.activeBlocks, 1);
    assert.equal(stats.compression.compressedTokens, 1234);
    assert.equal(stats.estimatedTokensAvoidedBySandbox, 1024);
  } finally {
    if (previous === undefined) delete process.env.HYPERCONTEXT_HOME;
    else process.env.HYPERCONTEXT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("project-scoped search excludes other projects and dedupes cross-db copies", () => {
  const home = mkdtempSync(join(tmpdir(), "hctx-scope-"));
  const previous = process.env.HYPERCONTEXT_HOME;
  process.env.HYPERCONTEXT_HOME = home;
  try {
    prepareRuntime(defaultConfig());
    const paths = getHypercontextPaths();
    mkdirSync(paths.contextContentDir, { recursive: true });
    const projectA = join(home, "project-a");
    const projectB = join(home, "project-b");
    const hashA = hashProjectDir(projectA);
    const hashB = hashProjectDir(projectB);
    createContentDb(join(paths.contextContentDir, `${hashA}.db`), "a.ts", "needle in project A");
    createContentDb(join(paths.contextContentDir, `${hashB}.db`), "b.ts", "needle in project B");
    // Duplicate content under a different DB must not double-report.
    createContentDb(join(paths.contextContentDir, `${hashB}-copy.db`), "b.ts", "needle in project B");

    const scoped = federatedSearch({ query: "needle", projectDir: projectA });
    assert.equal(scoped.diagnostics.projectHash, hashA);
    assert.equal(scoped.diagnostics.contentDbs, 1);
    assert.ok(scoped.hits.length > 0);
    assert.ok(scoped.hits.every((hit) => hit.source === "a.ts"));

    const all = federatedSearch({ query: "needle", allProjects: true });
    assert.equal(all.diagnostics.contentDbs, 3);
    assert.ok(all.hits.some((hit) => hit.source === "a.ts"));
    assert.ok(all.hits.some((hit) => hit.source === "b.ts"));
    assert.equal(all.hits.filter((hit) => hit.source === "b.ts" && hit.kind === "content").length, 1);
  } finally {
    if (previous === undefined) delete process.env.HYPERCONTEXT_HOME;
    else process.env.HYPERCONTEXT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
