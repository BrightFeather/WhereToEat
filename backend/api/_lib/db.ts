/**
 * Dual-backend DB layer.
 *
 * On Vercel (process.env.VERCEL === '1') → Neon Postgres.
 * Local dev (no VERCEL env)              → SQLite at backend/data/wheretoeat.db.
 *
 * Both expose the same callable `sql` tagged-template that returns
 * Promise<Row[]>. The SQL itself must stay dialect-portable:
 *   - No julianday() / datetime() / now() in queries — compute timestamps
 *     in JS and pass as parameters.
 *   - INTEGER booleans (0/1) work on both.
 *   - ON CONFLICT (col) DO UPDATE / DO NOTHING works on both.
 *   - JSON stored as TEXT works on both.
 *
 * Schema is created via:
 *   npm run migrate         → local SQLite
 *   npm run migrate:cloud   → Neon Postgres
 *
 * Data is copied from local → cloud via:
 *   npm run push-data
 */

const ON_VERCEL = process.env.VERCEL === '1';

type Row = Record<string, unknown>;
type SqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;
/** Run a literal SQL string with no parameters. Used by callers that need
 *  array expansion (`IN (...)`) which the tagged template can't express
 *  portably across both dialects. The caller is responsible for sanitizing
 *  any interpolated values — only use with validated tokens (e.g. UUIDs). */
type SqlRawFn = (query: string) => Promise<Row[]>;

let sqliteHandle: import('better-sqlite3').Database | undefined;

function makeNeon(): { sql: SqlFn; sqlRaw: SqlRawFn } {
  // Lazy import so the local path doesn't require @neondatabase/serverless to be reachable
  const { neon } = require('@neondatabase/serverless') as typeof import('@neondatabase/serverless');
  const url =
    process.env.DATABASE_URL ||
    process.env.WHERE_TO_EAT_DATABASE_URL ||
    process.env.WHERE_TO_EAT_POSTGRES_URL ||
    process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      'No Neon connection string found in env. Tried DATABASE_URL, WHERE_TO_EAT_DATABASE_URL, WHERE_TO_EAT_POSTGRES_URL, POSTGRES_URL.'
    );
  }
  const neonSql = neon(url);
  return {
    sql: neonSql as unknown as SqlFn,
    // Neon exposes `sql.query(rawSql, params)` for parameterless / dynamic
    // queries. The tagged-template `sql\`...\`` form can't always be coerced
    // from a runtime-built string, so we use the documented `query` method.
    sqlRaw: async (query) => {
      const out = await (neonSql as unknown as { query: (q: string, p?: unknown[]) => Promise<Row[] | { rows: Row[] }> }).query(query, []);
      // Some neon versions return `{ rows: [...] }`, others return the array directly.
      return Array.isArray(out) ? out : (out as { rows: Row[] }).rows;
    },
  };
}

function makeSqlite(): { sql: SqlFn; sqlRaw: SqlRawFn } {
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const path = require('path') as typeof import('path');
  const fs = require('fs') as typeof import('fs');

  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'wheretoeat.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteHandle = db;

  const sql: SqlFn = function sql(strings, ...values) {
    let query = '';
    strings.forEach((str, i) => {
      query += str;
      if (i < values.length) query += '?';
    });
    const stmt = db.prepare(query);
    const upper = query.trimStart().toUpperCase();
    if (upper.startsWith('SELECT') || /\bRETURNING\b/.test(upper)) {
      return Promise.resolve(stmt.all(values) as Row[]);
    }
    stmt.run(values);
    return Promise.resolve([]);
  };
  const sqlRaw: SqlRawFn = (query) => {
    const stmt = db.prepare(query);
    const upper = query.trimStart().toUpperCase();
    if (upper.startsWith('SELECT') || /\bRETURNING\b/.test(upper)) {
      return Promise.resolve(stmt.all() as Row[]);
    }
    stmt.run();
    return Promise.resolve([]);
  };
  return { sql, sqlRaw };
}

const handles = ON_VERCEL ? makeNeon() : makeSqlite();
export const sql: SqlFn = handles.sql;
export const sqlRaw: SqlRawFn = handles.sqlRaw;

/** Current timestamp as an ISO string. Use this in queries instead of
 *  database-specific functions like `now()` or `datetime('now')`. */
export const nowIso = (): string => new Date().toISOString();
