import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getHypercontextPaths, type HypercontextPaths } from "./paths.ts";
import {
  allRows,
  closeQuietly,
  firstRow,
  numberValue,
  openReadonly,
  stringValue,
  tableColumns,
  tableExists,
} from "./sqlite.ts";

export type SearchLayer = "sandbox" | "compression";
export type SearchScope = "all" | SearchLayer;

export interface SearchHit {
  layer: SearchLayer;
  kind: "content" | "session-event" | "compression-summary" | "compression-message" | "compression-archived-content";
  title: string;
  snippet: string;
  source: string;
  timestamp?: string;
  sessionId?: string;
  ref?: string;
  blockId?: string;
  score?: number;
  db: string;
}

export interface SearchDiagnostics {
  contentDbs: number;
  sessionDbs: number;
  compressionIndex: boolean;
  projectHash?: string;
  sessionId?: string;
  compressionSessionMatched?: boolean;
  errors: string[];
}

export interface SessionIdentity {
  projectHash: string;
  sandboxSessionId?: string;
  compressionSessionIds: string[];
  matched: boolean;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  diagnostics: SearchDiagnostics;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  scope?: SearchScope;
  paths?: HypercontextPaths;
  /** Scope sandbox DBs to this project. Omit to scan every project. */
  projectDir?: string;
  /** Explicitly scan every project even when projectDir is supplied. */
  allProjects?: boolean;
  /** Explicitly join both layers on this host/session id. */
  sessionId?: string;
  /** Ignore the inferred active session and search every session. */
  allSessions?: boolean;
}

/**
 * Mirrors context-mode's canonical project hash (src/session/db.ts):
 * slash-normalized path, case-folded on Windows/macOS, sha256, first 16 hex.
 * Content DBs are `<hash>.db`; session DBs are `<hash><worktreeSuffix>.db`.
 */
export function hashProjectDir(projectDir: string, platform = process.platform): string {
  let normalized = projectDir.replace(/\\/g, "/");
  if (!/^\/+$/.test(normalized)) {
    if (/^[A-Za-z]:\/+$/.test(normalized)) normalized = `${normalized.slice(0, 2)}/`;
    else normalized = normalized.replace(/\/+$/, "");
  }
  const folded = platform === "win32" || platform === "darwin" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update(folded).digest("hex").slice(0, 16);
}

function listDbFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".db"))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function cleanSnippet(value: string, max = 320): string {
  let text = value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string") {
      text = parsed;
    } else if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const candidate = record.text ?? record.content ?? record.summary ?? record.message ?? record.data;
      if (typeof candidate === "string") text = candidate;
    }
  } catch {
    // not JSON — use the raw text
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function ftsExpression(query: string): string {
  const tokens = query
    .replace(/["']/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token}"`).join(" ");
}

function searchContentDb(
  file: string,
  expression: string,
  rawQuery: string,
  limit: number,
  errors: string[],
): SearchHit[] {
  const opened = openReadonly(file);
  if (!opened.db) {
    errors.push(`${basename(file)}: ${opened.error ?? "open failed"}`);
    return [];
  }
  const db = opened.db;
  const hits: SearchHit[] = [];
  try {
    if (!tableExists(db, "chunks") || !tableExists(db, "sources")) return [];
    const columns = tableColumns(db, "chunks");
    const contentCol = columns.has("content") ? "c.content" : null;
    const titleCol = columns.has("title") ? "c.title" : "''";
    const sourceJoin = columns.has("source_id")
      ? "JOIN sources s ON s.id = c.source_id"
      : "LEFT JOIN sources s ON 1 = 0";
    const metadata = {
      contentType: columns.has("content_type") ? "c.content_type" : "''",
      category: columns.has("source_category") ? "c.source_category" : "''",
      sessionId: columns.has("session_id") ? "c.session_id" : "''",
      timestamp: columns.has("timestamp") ? "c.timestamp" : "''",
    };

    const runMatch = (table: string, match: string): void => {
      const sql = `SELECT c.rowid AS rid, s.label AS source_label, ${titleCol} AS title,
        snippet(${table}, 1, '', '', ' … ', 18) AS snippet, ${metadata.contentType} AS content_type,
        ${metadata.category} AS source_category, ${metadata.sessionId} AS session_id,
        ${metadata.timestamp} AS ts, bm25(${table}) AS rank
        FROM ${table} c ${sourceJoin}
        WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`;
      const rows = allRows(db, sql, [match, limit]);
      for (const row of rows) {
        const source = stringValue(row.source_label);
        hits.push({
          layer: "sandbox",
          kind: "content",
          title: stringValue(row.title) || source || "indexed content",
          snippet: cleanSnippet(stringValue(row.snippet)),
          source: source || "context-mode",
          timestamp: stringValue(row.ts) || undefined,
          sessionId: stringValue(row.session_id) || undefined,
          score: numberValue(row.rank),
          db: file,
        });
      }
    };

    if (expression) runMatch("chunks", expression);
    if (hits.length === 0 && rawQuery.length >= 3 && tableExists(db, "chunks_trigram")) {
      runMatch("chunks_trigram", rawQuery.replace(/["']/g, " "));
    }

    if (hits.length === 0 && contentCol) {
      const like = `%${rawQuery.replace(/[%_]/g, (char) => `\\${char}`)}%`;
      const rows = allRows(
        db,
        `SELECT s.label AS source_label, ${titleCol} AS title, substr(${contentCol}, 1, 320) AS snippet,
           ${metadata.contentType} AS content_type, ${metadata.sessionId} AS session_id,
           ${metadata.timestamp} AS ts
         FROM chunks c ${sourceJoin}
         WHERE ${contentCol} LIKE ? ESCAPE '\\' OR ${titleCol} LIKE ? ESCAPE '\\'
         LIMIT ?`,
        [like, like, limit],
      );
      for (const row of rows) {
        hits.push({
          layer: "sandbox",
          kind: "content",
          title: stringValue(row.title) || stringValue(row.source_label) || "indexed content",
          snippet: cleanSnippet(stringValue(row.snippet)),
          source: stringValue(row.source_label) || "context-mode",
          timestamp: stringValue(row.ts) || undefined,
          sessionId: stringValue(row.session_id) || undefined,
          db: file,
        });
      }
    }
  } finally {
    closeQuietly(db);
  }
  return hits;
}

function searchSessionDb(
  file: string,
  rawQuery: string,
  limit: number,
  errors: string[],
): SearchHit[] {
  const opened = openReadonly(file);
  if (!opened.db) {
    errors.push(`${basename(file)}: ${opened.error ?? "open failed"}`);
    return [];
  }
  const db = opened.db;
  try {
    if (!tableExists(db, "session_events")) return [];
    const columns = tableColumns(db, "session_events");
    if (!columns.has("data")) return [];
    const like = `%${rawQuery.replace(/[%_]/g, (char) => `\\${char}`)}%`;
    const typeExpr = columns.has("type") ? "type" : "''";
    const categoryExpr = columns.has("category") ? "category" : "''";
    const createdExpr = columns.has("created_at") ? "created_at" : "''";
    const rows = allRows(
      db,
      `SELECT session_id, ${typeExpr} AS type, ${categoryExpr} AS category, data,
         ${createdExpr} AS created_at
       FROM session_events
       WHERE data LIKE ? ESCAPE '\\' OR ${typeExpr} LIKE ? ESCAPE '\\'
       ORDER BY id DESC LIMIT ?`,
      [like, like, limit],
    );
    return rows.map((row) => ({
      layer: "sandbox" as const,
      kind: "session-event" as const,
      title: `${stringValue(row.category) || "event"} · ${stringValue(row.type) || "session"}`,
      snippet: cleanSnippet(stringValue(row.data)),
      source: "session-memory",
      timestamp: stringValue(row.created_at) || undefined,
      sessionId: stringValue(row.session_id) || undefined,
      db: file,
    }));
  } finally {
    closeQuietly(db);
  }
}

function searchCompressionIndex(file: string, rawQuery: string, limit: number, errors: string[]): SearchHit[] {
  const opened = openReadonly(file);
  if (!opened.db) {
    errors.push(`index.db: ${opened.error ?? "open failed"}`);
    return [];
  }
  const db = opened.db;
  const hits: SearchHit[] = [];
  const like = `%${rawQuery.replace(/[%_]/g, (char) => `\\${char}`)}%`;
  try {
    if (tableExists(db, "blocks") && tableExists(db, "content")) {
      const hasJson = true;
      const sessionTitle = tableExists(db, "sessions") ? "s.title" : "''";
      const joinSessions = tableExists(db, "sessions") ? "LEFT JOIN sessions s ON s.session_id = b.session_id" : "";
      const rows = allRows(
        db,
        `SELECT b.session_id, b.block_id, b.start_ref, b.end_ref, b.tier, b.active, b.created_at,
           ${sessionTitle} AS session_title,
           CAST(c.bytes AS TEXT) AS summary,
           ${hasJson ? "json_extract(b.payload_json, '$.topic')" : "''"} AS topic,
           ${hasJson ? "json_extract(b.payload_json, '$.compressedTokens')" : "0"} AS compressed_tokens
         FROM blocks b
         JOIN content c ON c.hash = b.summary_hash
         ${joinSessions}
         WHERE b.active = 1 AND (CAST(c.bytes AS TEXT) LIKE ? ESCAPE '\\'
           OR ${hasJson ? "COALESCE(json_extract(b.payload_json, '$.topic'), '') LIKE ? ESCAPE '\\'" : "0"})
         ORDER BY b.created_at DESC LIMIT ?`,
        [like, like, limit],
      );
      for (const row of rows) {
        const startRef = numberValue(row.start_ref);
        const endRef = numberValue(row.end_ref);
        hits.push({
          layer: "compression",
          kind: "compression-summary",
          title: stringValue(row.topic) || stringValue(row.session_title) || `compressed range ${startRef}-${endRef}`,
          snippet: cleanSnippet(stringValue(row.summary)),
          source: `bili:${stringValue(row.session_id)}`,
          timestamp: row.created_at ? new Date(numberValue(row.created_at)).toISOString() : undefined,
          sessionId: stringValue(row.session_id) || undefined,
          ref: startRef && endRef ? `${startRef}-${endRef}` : undefined,
          blockId: stringValue(row.block_id) || undefined,
          db: file,
        });
      }
    }

    if (tableExists(db, "messages") && tableExists(db, "content")) {
      const rows = allRows(
        db,
        `SELECT m.session_id, m.seq, m.msg_id, m.ref, m.ref_num, m.role, m.kind,
           CAST(c.bytes AS TEXT) AS content
         FROM messages m JOIN content c ON c.hash = m.content_hash
         WHERE CAST(c.bytes AS TEXT) LIKE ? ESCAPE '\\'
         ORDER BY m.seq DESC LIMIT ?`,
        [like, limit],
      );
      for (const row of rows) {
        hits.push({
          layer: "compression",
          kind: "compression-message",
          title: `${stringValue(row.role) || "message"} ${stringValue(row.ref) || stringValue(row.msg_id)}`,
          snippet: cleanSnippet(stringValue(row.content)),
          source: `bili:${stringValue(row.session_id)}`,
          sessionId: stringValue(row.session_id) || undefined,
          ref: stringValue(row.ref) || undefined,
          db: file,
        });
      }
    }

    // Archived raw content: a host that compacts on its OWN (OpenCode, Claude
    // Code, Codex) replaces the history with a summary, and the engine prunes
    // the message rows that pointed at the dropped raw text. The bytes
    // themselves survive in the content CAS — but nothing references them any
    // more, so the message join above can never reach them. Search the
    // orphans directly, otherwise the one thing this layer is supposed to add
    // (the pre-compaction text stays findable) is lost with the host's
    // compaction.
    if (tableExists(db, "content")) {
      const orphanRows = allRows(
        db,
        `SELECT c.hash, c.byte_len, CAST(c.bytes AS TEXT) AS content
           FROM content c
          WHERE CAST(c.bytes AS TEXT) LIKE ? ESCAPE '\\'
            AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.content_hash = c.hash)
            AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.summary_hash = c.hash)
          LIMIT ?`,
        [like, limit],
      );
      for (const row of orphanRows) {
        hits.push({
          layer: "compression",
          kind: "compression-archived-content",
          title: "archived content (dropped by a host-side compaction)",
          snippet: cleanSnippet(stringValue(row.content)),
          source: "bili:archive",
          db: file,
        });
      }
    }
  } finally {
    closeQuietly(db);
  }
  return hits;
}

function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const result: SearchHit[] = [];
  for (const hit of hits) {
    const key = `${hit.layer}|${hit.kind}|${hit.source}|${hit.sessionId ?? ""}|${hit.ref ?? hit.blockId ?? ""}|${hit.snippet.slice(0, 160)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hit);
  }
  return result;
}

function filterProject(files: string[], projectHash: string | null): string[] {
  if (!projectHash) return files;
  return files.filter((file) => basename(file).startsWith(projectHash));
}

function normalizeProjectDir(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

/**
 * Join the host's native session identity across both layers. Context-mode
 * hooks already persist the host session id into session_meta.project_dir;
 * billion-context uses the same client header as its session key. If that id
 * exists in the compression index, federated search can scope both layers to
 * one conversation without asking the user for a second id.
 */
export function resolveSessionIdentity(
  options: { projectDir: string; paths?: HypercontextPaths },
): SessionIdentity {
  const paths = options.paths ?? getHypercontextPaths();
  const projectHash = hashProjectDir(options.projectDir);
  const target = normalizeProjectDir(options.projectDir);
  let sandboxSessionId: string | undefined;
  let latest = "";

  for (const file of listDbFiles(paths.contextSessionsDir)) {
    const opened = openReadonly(file);
    if (!opened.db) continue;
    try {
      if (!tableExists(opened.db, "session_meta")) continue;
      const rows = allRows(
        opened.db,
        `SELECT session_id, project_dir, COALESCE(last_event_at, started_at) AS at
           FROM session_meta
           ORDER BY COALESCE(last_event_at, started_at) DESC
           LIMIT 25`,
      );
      for (const row of rows) {
        const sessionId = stringValue(row.session_id);
        const projectDir = stringValue(row.project_dir);
        if (!sessionId) continue;
        if (projectDir && normalizeProjectDir(projectDir) !== target) continue;
        const at = stringValue(row.at);
        if (sandboxSessionId === undefined || at > latest) {
          sandboxSessionId = sessionId;
          latest = at;
        }
        break;
      }
    } finally {
      closeQuietly(opened.db);
    }
  }

  const compressionSessionIds: string[] = [];
  const indexFile = join(paths.compressionSessionsDir, "index.db");
  if (existsSync(indexFile)) {
    const opened = openReadonly(indexFile);
    if (opened.db) {
      try {
        if (tableExists(opened.db, "sessions")) {
          const rows = allRows(opened.db, "SELECT session_id FROM sessions");
          for (const row of rows) {
            const sessionId = stringValue(row.session_id);
            if (sessionId) compressionSessionIds.push(sessionId);
          }
        }
      } finally {
        closeQuietly(opened.db);
      }
    }
  }

  const matched = Boolean(sandboxSessionId && compressionSessionIds.includes(sandboxSessionId));
  return { projectHash, sandboxSessionId, compressionSessionIds, matched };
}


function interleave(layerHits: SearchHit[][], limit: number): SearchHit[] {
  const result: SearchHit[] = [];
  let cursor = 0;
  while (result.length < limit) {
    let added = false;
    for (const hits of layerHits) {
      if (hits[cursor]) {
        result.push(hits[cursor]!);
        added = true;
        if (result.length >= limit) return result;
      }
    }
    if (!added) break;
    cursor += 1;
  }
  return result;
}

export function federatedSearch(options: SearchOptions): SearchResult {
  const paths = options.paths ?? getHypercontextPaths();
  const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
  const scope = options.scope ?? "all";
  const query = options.query.trim();
  const projectHash = options.projectDir && !options.allProjects ? hashProjectDir(options.projectDir) : null;
  const identity = options.projectDir
    ? resolveSessionIdentity({ projectDir: options.projectDir, paths })
    : undefined;
  const requestedSession = options.allSessions || options.allProjects
    ? undefined
    : options.sessionId?.trim() || (identity?.matched ? identity.sandboxSessionId : undefined);
  const diagnostics: SearchDiagnostics = {
    contentDbs: 0,
    sessionDbs: 0,
    compressionIndex: false,
    projectHash: projectHash ?? undefined,
    sessionId: requestedSession,
    compressionSessionMatched: identity?.matched,
    errors: [],
  };
  if (!query) return { query, hits: [], diagnostics };

  const sandboxHits: SearchHit[] = [];
  const compressionHits: SearchHit[] = [];
  const expression = ftsExpression(query);

  if (scope === "all" || scope === "sandbox") {
    const contentDbs = filterProject(listDbFiles(paths.contextContentDir), projectHash);
    diagnostics.contentDbs = contentDbs.length;
    for (const file of contentDbs) {
      sandboxHits.push(...searchContentDb(file, expression, query, limit, diagnostics.errors));
    }
    const sessionDbs = filterProject(listDbFiles(paths.contextSessionsDir), projectHash);
    diagnostics.sessionDbs = sessionDbs.length;
    for (const file of sessionDbs) {
      sandboxHits.push(...searchSessionDb(file, query, Math.min(limit, 5), diagnostics.errors));
    }
  }

  if (scope === "all" || scope === "compression") {
    const indexFile = join(paths.compressionSessionsDir, "index.db");
    diagnostics.compressionIndex = existsSync(indexFile);
    if (diagnostics.compressionIndex) {
      compressionHits.push(...searchCompressionIndex(indexFile, query, limit, diagnostics.errors));
    }
  }

  const orderedSandbox = dedupeHits(sandboxHits).slice(0, limit);
  const orderedCompression = dedupeHits(compressionHits).slice(0, limit);
  const scoped = (hits: SearchHit[]): SearchHit[] =>
    requestedSession
      ? hits.filter((hit) => !hit.sessionId || hit.sessionId === requestedSession)
      : hits;
  const hits =
    scope === "sandbox"
      ? scoped(orderedSandbox)
      : scope === "compression"
        ? scoped(orderedCompression)
        : interleave([scoped(orderedSandbox), scoped(orderedCompression)], limit);

  return { query, hits, diagnostics };
}

export interface SandboxStats {
  contentDbs: number;
  sourceCount: number;
  chunkCount: number;
  sessionDbs: number;
  sessions: number;
  events: number;
  bytesAvoided: number;
  bytesReturned: number;
  toolCalls: number;
  storageBytes: number;
  lastActivity?: string;
}

export interface CompressionStats {
  indexPresent: boolean;
  sessions: number;
  activeSessions: number;
  messages: number;
  activeBlocks: number;
  compressedTokens: number;
  requests: number;
  storageBytes: number;
  lastActivity?: string;
  recentSessions: Array<{ id: string; title: string; updatedAt?: string }>;
}

export interface UnifiedStats {
  sandbox: SandboxStats;
  compression: CompressionStats;
  storageBytes: number;
  estimatedTokensAvoidedBySandbox: number;
}

function safeMtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function collectStats(options: { paths?: HypercontextPaths } = {}): UnifiedStats {
  const paths = options.paths ?? getHypercontextPaths();
  const sandbox: SandboxStats = {
    contentDbs: 0,
    sourceCount: 0,
    chunkCount: 0,
    sessionDbs: 0,
    sessions: 0,
    events: 0,
    bytesAvoided: 0,
    bytesReturned: 0,
    toolCalls: 0,
    storageBytes: 0,
  };
  const compression: CompressionStats = {
    indexPresent: false,
    sessions: 0,
    activeSessions: 0,
    messages: 0,
    activeBlocks: 0,
    compressedTokens: 0,
    requests: 0,
    storageBytes: 0,
    recentSessions: [],
  };

  let lastSandbox = 0;
  let lastCompression = 0;

  for (const file of listDbFiles(paths.contextContentDir)) {
    sandbox.contentDbs += 1;
    sandbox.storageBytes += safeMtime(file) > 0 ? statSafe(file) : 0;
    lastSandbox = Math.max(lastSandbox, safeMtime(file));
    const opened = openReadonly(file);
    if (!opened.db) continue;
    try {
      if (tableExists(opened.db, "sources")) {
        const row = firstRow(opened.db, "SELECT COUNT(*) AS n, MAX(indexed_at) AS latest FROM sources");
        sandbox.sourceCount += numberValue(row?.n);
        if (typeof row?.latest === "string" && row.latest) {
          const t = Date.parse(row.latest);
          if (Number.isFinite(t)) lastSandbox = Math.max(lastSandbox, t);
        }
      }
      if (tableExists(opened.db, "chunks")) {
        const row = firstRow(opened.db, "SELECT COUNT(*) AS n FROM chunks");
        sandbox.chunkCount += numberValue(row?.n);
      }
    } finally {
      closeQuietly(opened.db);
    }
  }

  for (const file of listDbFiles(paths.contextSessionsDir)) {
    sandbox.sessionDbs += 1;
    sandbox.storageBytes += statSafe(file);
    lastSandbox = Math.max(lastSandbox, safeMtime(file));
    const opened = openReadonly(file);
    if (!opened.db) continue;
    try {
      if (tableExists(opened.db, "session_meta")) {
        const row = firstRow(
          opened.db,
          "SELECT COUNT(*) AS n, MAX(last_event_at) AS latest FROM session_meta",
        );
        sandbox.sessions += numberValue(row?.n);
        if (typeof row?.latest === "string" && row.latest) {
          const t = Date.parse(row.latest);
          if (Number.isFinite(t)) lastSandbox = Math.max(lastSandbox, t);
        }
      }
      if (tableExists(opened.db, "session_events")) {
        const row = firstRow(
          opened.db,
          "SELECT COUNT(*) AS n, COALESCE(SUM(bytes_avoided), 0) AS avoided, COALESCE(SUM(bytes_returned), 0) AS returned FROM session_events",
        );
        sandbox.events += numberValue(row?.n);
        sandbox.bytesAvoided += numberValue(row?.avoided);
        sandbox.bytesReturned += numberValue(row?.returned);
      }
      if (tableExists(opened.db, "tool_calls")) {
        const row = firstRow(opened.db, "SELECT COALESCE(SUM(calls), 0) AS n FROM tool_calls");
        sandbox.toolCalls += numberValue(row?.n);
      }
    } finally {
      closeQuietly(opened.db);
    }
  }

  const indexFile = join(paths.compressionSessionsDir, "index.db");
  compression.indexPresent = existsSync(indexFile);
  if (compression.indexPresent) {
    compression.storageBytes += statSafe(indexFile);
    lastCompression = Math.max(lastCompression, safeMtime(indexFile));
    const opened = openReadonly(indexFile);
    if (opened.db) {
      try {
        const db: DatabaseSync = opened.db;
        if (tableExists(db, "sessions")) {
          const row = firstRow(
            db,
            "SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active, MAX(updated_at) AS latest FROM sessions",
          );
          compression.sessions = numberValue(row?.n);
          compression.activeSessions = numberValue(row?.active);
          const latest = numberValue(row?.latest);
          if (latest > 0) lastCompression = Math.max(lastCompression, latest);
          const recent = allRows(
            db,
            `SELECT session_id, COALESCE(NULLIF(title, ''), NULLIF(host_title, ''), NULLIF(label, ''), session_id) AS title,
               updated_at FROM sessions ORDER BY updated_at DESC LIMIT 5`,
          );
          compression.recentSessions = recent.map((row) => ({
            id: stringValue(row.session_id),
            title: stringValue(row.title) || stringValue(row.session_id),
            updatedAt: numberValue(row.updated_at)
              ? new Date(numberValue(row.updated_at)).toISOString()
              : undefined,
          }));
          const statsRows = allRows(db, "SELECT stats_json FROM sessions");
          for (const statsRow of statsRows) {
            try {
              const stats = JSON.parse(stringValue(statsRow.stats_json)) as Record<string, unknown>;
              compression.requests += numberValue(stats.requests);
            } catch {
              // ignore malformed stats
            }
          }
        }
        if (tableExists(db, "messages")) {
          const row = firstRow(db, "SELECT COUNT(*) AS n FROM messages");
          compression.messages = numberValue(row?.n);
        }
        if (tableExists(db, "blocks")) {
          const row = firstRow(
            db,
            "SELECT COUNT(*) AS n, COALESCE(SUM(CAST(json_extract(payload_json, '$.compressedTokens') AS INTEGER)), 0) AS tokens FROM blocks WHERE active = 1",
          );
          compression.activeBlocks = numberValue(row?.n);
          compression.compressedTokens = numberValue(row?.tokens);
        }
        if (tableExists(db, "content")) {
          const row = firstRow(db, "SELECT COALESCE(SUM(byte_len), 0) AS bytes FROM content");
          compression.storageBytes += numberValue(row?.bytes);
        }
      } finally {
        closeQuietly(opened.db);
      }
    }
  }

  if (lastSandbox > 0) sandbox.lastActivity = new Date(lastSandbox).toISOString();
  if (lastCompression > 0) compression.lastActivity = new Date(lastCompression).toISOString();

  return {
    sandbox,
    compression,
    storageBytes: sandbox.storageBytes + compression.storageBytes,
    estimatedTokensAvoidedBySandbox: Math.round(sandbox.bytesAvoided / 4),
  };
}

function statSafe(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
