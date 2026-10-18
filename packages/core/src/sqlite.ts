import { DatabaseSync } from "node:sqlite";

export type SqlRow = Record<string, unknown>;

export interface OpenReadonlyResult {
  db: DatabaseSync | null;
  error?: string;
}

export function openReadonly(file: string): OpenReadonlyResult {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 1500");
    } catch {
      // PRAGMA is best effort on read-only connections.
    }
    return { db };
  } catch (error) {
    return { db: null, error: String(error) };
  }
}

export function closeQuietly(db: DatabaseSync | null): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // ignore
  }
}

export function tableExists(db: DatabaseSync, name: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE name = ? AND type IN ('table','view') LIMIT 1")
      .get(name) as { present?: number } | undefined;
    return row?.present === 1;
  } catch {
    return false;
  }
}

export function tableColumns(db: DatabaseSync, name: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as Array<{ name?: unknown }>;
    return new Set(rows.map((row) => String(row.name ?? "")));
  } catch {
    return new Set();
  }
}

export function allRows(db: DatabaseSync, sql: string, params: Array<string | number> = []): SqlRow[] {
  try {
    return db.prepare(sql).all(...params) as SqlRow[];
  } catch {
    return [];
  }
}

export function firstRow(db: DatabaseSync, sql: string, params: Array<string | number> = []): SqlRow | undefined {
  try {
    return db.prepare(sql).get(...params) as SqlRow | undefined;
  } catch {
    return undefined;
  }
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value);
}
