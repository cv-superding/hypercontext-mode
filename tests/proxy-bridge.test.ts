import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { searchHypercontextSandbox } from "../engines/billion-context/src/hypercontext-bridge.ts";

test("proxy search_context bridge is opt-in and reads the sandbox index", () => {
  const dir = mkdtempSync(join(tmpdir(), "hctx-bridge-"));
  const previousHyper = process.env.HYPERCONTEXT;
  const previousDir = process.env.CONTEXT_MODE_DIR;
  try {
    const contentDir = join(dir, "content");
    mkdirSync(contentDir, { recursive: true });
    const db = new DatabaseSync(join(contentDir, "project.db"));
    db.exec(`
      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0, code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')), file_path TEXT, content_hash TEXT
      );
      CREATE VIRTUAL TABLE chunks USING fts5(
        title, content, source_id UNINDEXED, content_type UNINDEXED,
        source_category UNINDEXED, session_id UNINDEXED, event_id UNINDEXED,
        timestamp UNINDEXED, tokenize='porter unicode61'
      );
    `);
    db.prepare("INSERT INTO sources (label) VALUES (?)").run("notes");
    db.prepare(
      "INSERT INTO chunks (title, content, source_id, content_type, source_category, session_id, event_id, timestamp) VALUES ('bridge', 'sandbox bridge needle evidence', 1, 'prose', 'file', 's', '0', '')",
    ).run();
    db.close();

    process.env.CONTEXT_MODE_DIR = dir;
    process.env.HYPERCONTEXT = "1";
    const hit = searchHypercontextSandbox("bridge needle");
    assert.match(hit, /HyperContext sandbox index/);
    assert.match(hit, /sandbox bridge needle evidence/);

    delete process.env.HYPERCONTEXT;
    assert.equal(searchHypercontextSandbox("bridge needle"), "");
  } finally {
    if (previousHyper === undefined) delete process.env.HYPERCONTEXT;
    else process.env.HYPERCONTEXT = previousHyper;
    if (previousDir === undefined) delete process.env.CONTEXT_MODE_DIR;
    else process.env.CONTEXT_MODE_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
