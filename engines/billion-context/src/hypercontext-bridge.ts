/**
 * HyperContext integration: expose the sandbox layer's FTS5 index to the
 * proxy-side `search_context` tool.
 *
 * This module is intentionally dependency-free and returns "" unless the
 * unified runtime sets HYPERCONTEXT=1. Upstream bili behavior (including all
 * golden wire tests) stays byte-identical without that env var.
 *
 * It reads context-mode's content DBs directly with node:sqlite. Failure of
 * any kind degrades to no extra results; it must never break a model turn.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface SqliteStatement {
    all(...params: Array<string | number>): unknown[];
}

interface SqliteDb {
    prepare(sql: string): SqliteStatement;
    close(): void;
}

interface SqliteModule {
    DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDb;
}

interface Hit {
    source: string;
    title: string;
    snippet: string;
    timestamp: string;
}

const MAX_DBS = 64;
const MAX_SNIPPET = 220;

function getSqlite(): SqliteModule | null {
    const proc = process as unknown as { getBuiltinModule?: (id: string) => unknown };
    const mod = proc.getBuiltinModule?.("node:sqlite");
    return mod && typeof (mod as SqliteModule).DatabaseSync === "function" ? (mod as SqliteModule) : null;
}

function contentDir(): string {
    const root = process.env.CONTEXT_MODE_DIR;
    return root ? join(root, "content") : "";
}

function listDbs(dir: string): string[] {
    try {
        return readdirSync(dir)
            .filter((name) => name.endsWith(".db"))
            .slice(0, MAX_DBS)
            .map((name) => join(dir, name));
    } catch {
        return [];
    }
}

function quoteTokens(query: string): string {
    return query
        .replace(/["']/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 8)
        .map((token) => `"${token}"`)
        .join(" ");
}

function clean(value: unknown): string {
    const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > MAX_SNIPPET ? `${flat.slice(0, MAX_SNIPPET - 1)}…` : flat;
}

function searchDb(file: string, query: string, limit: number): Hit[] {
    const sqlite = getSqlite();
    if (!sqlite) return [];
    let db: SqliteDb | null = null;
    try {
        db = new sqlite.DatabaseSync(file, { readOnly: true });
        const match = quoteTokens(query);
        const rows = match
            ? db
                  .prepare(
                      `SELECT s.label AS source, c.title AS title, snippet(chunks, 1, '', '', ' … ', 16) AS snippet,
                         c.timestamp AS ts, bm25(chunks) AS rank
                       FROM chunks c JOIN sources s ON s.id = c.source_id
                       WHERE chunks MATCH ? ORDER BY rank LIMIT ?`,
                  )
                  .all(match, limit)
            : [];
        const fallback =
            rows.length > 0
                ? rows
                : db
                      .prepare(
                          `SELECT s.label AS source, c.title AS title, substr(c.content, 1, 240) AS snippet,
                             c.timestamp AS ts
                           FROM chunks c JOIN sources s ON s.id = c.source_id
                           WHERE c.content LIKE ? OR c.title LIKE ? LIMIT ?`,
                      )
                      .all(`%${query.replace(/[%_]/g, (char) => `\\${char}`)}%`, `%${query.replace(/[%_]/g, (char) => `\\${char}`)}%`, limit);
        return fallback.map((row) => {
            const record = row as Record<string, unknown>;
            return {
                source: clean(record.source) || "sandbox",
                title: clean(record.title),
                snippet: clean(record.snippet),
                timestamp: clean(record.ts),
            };
        });
    } catch {
        return [];
    } finally {
        try {
            db?.close();
        } catch {
            // ignore
        }
    }
}

export function searchHypercontextSandbox(query: string, limit = 4): string {
    if (process.env.HYPERCONTEXT !== "1" || process.env.HYPERCONTEXT_SANDBOX_SEARCH === "0") return "";
    if (!query.trim()) return "";
    const dir = contentDir();
    if (!dir || !existsSync(dir)) return "";
    const files = listDbs(dir);
    if (files.length === 0) return "";

    const seen = new Set<string>();
    const hits: Hit[] = [];
    for (const file of files) {
        for (const hit of searchDb(file, query, limit)) {
            const key = `${hit.source}|${hit.snippet.slice(0, 120)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            hits.push(hit);
            if (hits.length >= limit) break;
        }
        if (hits.length >= limit) break;
    }
    if (hits.length === 0) return "";

    const lines = hits.map((hit) => {
        const title = hit.title && hit.title !== "Untitled" ? `${hit.title} · ` : "";
        const time = hit.timestamp ? ` [${hit.timestamp}]` : "";
        return `- ${hit.source}: ${title}${hit.snippet}${time}`;
    });
    return `\n\n[HyperContext sandbox index — ${hits.length} hit(s) from indexed tool/web/file output and session memory; raw bytes stay out of context]\n${lines.join("\n")}`;
}
