// One tiny query helper, two engines: Postgres (DATABASE_URL=postgres://…) or an embedded SQLite file
// (DATABASE_URL=sqlite:/path/to/file.db). SQL is written once, in Postgres flavour, and
// translated for SQLite below: the handful of differences fit in a few lines.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { env } from "./env.js";
import { migrations } from "./migrations.js";
import { extensions } from "./extend.js";

export type Q = <T = any>(text: string, params?: unknown[]) => Promise<T[]>;

export const isSqlite = !env.databaseUrl.startsWith("postgres");
export const sqliteFile = isSqlite ? env.databaseUrl.replace(/^sqlite:/, "") : null;
const JSON_COLS = new Set(["data", "prefs", "app_state", "items"]);

let q: Q;
let tx: <T>(fn: (q: Q) => Promise<T>) => Promise<T>;
let authDatabase: unknown;
let pgPool: any = null;
let sqlite: any = null;

if (!isSqlite) {
  const pg = (await import("pg")).default;
  pgPool = new pg.Pool({ connectionString: env.databaseUrl });
  authDatabase = pgPool;
  q = async (text, params = []) => (await pgPool.query(text, params as any[])).rows;
  tx = async (fn) => {
    const client = await pgPool.connect();
    try {
      await client.query("begin");
      const out = await fn(async (text, params = []) => (await client.query(text, params as any[])).rows);
      await client.query("commit");
      return out;
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
} else {
  // Bun ships bun:sqlite; Node 22+ ships node:sqlite. Same prepare/run/all surface.
  // Module names kept in variables so neither bundler tries to resolve the other runtime's module.
  const bunSqlite = "bun:sqlite",
    nodeSqlite = "node:sqlite";
  // SQLite creates the file but not its folder, which a fresh checkout does not have yet.
  await mkdir(dirname(sqliteFile!), { recursive: true });
  sqlite = process.versions.bun
    ? new (await import(bunSqlite)).Database(sqliteFile, { create: true })
    : new (await import(nodeSqlite)).DatabaseSync(sqliteFile);
  sqlite.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  authDatabase = sqlite;
  q = async (text, params = []) => {
    const sql = toSqlite(text);
    const stmt = sqlite.prepare(sql);
    const args = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p instanceof Date ? p.toISOString() : p));
    if (/^\s*(select|with)/i.test(sql) || /\breturning\b/i.test(sql)) return stmt.all(...args).map(parseJson);
    stmt.run(...args);
    return [];
  };
  // SQLite has one connection: statements issued while the transaction is open belong to it.
  tx = async (fn) => {
    sqlite.exec("begin immediate");
    try {
      const out = await fn(q);
      sqlite.exec("commit");
      return out;
    } catch (e) {
      sqlite.exec("rollback");
      throw e;
    }
  };
}

function toSqlite(sql: string) {
  return sql
    .replace(/\$(\d+)/g, "?$1")
    .replace(/::jsonb/g, "")
    .replace(/::text\b/g, "")
    .replace(/\boctet_length\(([\w.]+)\)/g, "length(cast($1 as blob))")
    .replace(/\bnow\(\)/g, "current_timestamp")
    .replace(/\bgreatest\(/g, "max(")
    .replace(/(\w+)->>'(\w+)'/g, "json_extract($1, '$.$2')")
    .replace(/\bjsonb\b/g, "text")
    .replace(/\btimestamptz\b/g, "text")
    .replace(/\bbigint\b/g, "integer")
    .replace(/\bboolean\b/g, "integer")
    .replace(/prefs = user_prefs\.prefs \|\| excluded\.prefs/g, "prefs = json_patch(user_prefs.prefs, excluded.prefs)");
}

const parseJson = (row: Record<string, unknown>) => {
  for (const k of JSON_COLS)
    if (typeof row[k] === "string")
      try {
        row[k] = JSON.parse(row[k] as string);
      } catch {}
  return row;
};

// Timestamps come back as Date (Postgres) or "YYYY-MM-DD HH:MM:SS" UTC text (SQLite), with the "+00" of
// sqlTime when written from one.
export const toDate = (v: unknown) =>
  v instanceof Date
    ? v
    : typeof v === "number"
      ? new Date(v)
      : new Date(
          /^\d{4}-\d\d-\d\d \d/.test(String(v))
            ? String(v)
                .replace(" ", "T")
                .replace(/(\+00)?$/, "Z")
            : String(v),
        );

// A timestamp both engines compare correctly against their own columns.
export const sqlTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19) + "+00";

export { q, tx, authDatabase, pgPool, sqlite };

// This version's migrations, then the extensions' (extend.ts). An id applied here that neither knows (a migration
// of an extension not registered, or one retired) is only reported.
export async function migrate() {
  const all = [...migrations, ...extensions().flatMap((e) => e.migrations ?? [])];
  const twice = all.map((m) => m.id).find((id, i, ids) => ids.indexOf(id) !== i);
  if (twice) throw new Error(`database: migration ${twice} is defined twice`);
  await q(`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await q<{ id: string }>(`select id from schema_migrations`)).map((r) => r.id));
  const unknown = [...done].filter((id) => !all.some((m) => m.id === id)).sort();
  if (unknown.length) console.log(`database: applied before, not known here: ${unknown.join(", ")}`);
  for (const m of all) {
    if (done.has(m.id)) continue;
    const text = [m.sql ?? "", (isSqlite ? m.sqlite : m.pg) ?? ""].join(";\n");
    const statements = text
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s && !/^(--[^\n]*\n?)+$/.test(s));
    await tx(async (t) => {
      for (const s of statements) await t(s);
      await t(`insert into schema_migrations (id) values ($1)`, [m.id]);
    });
    console.log(`database: applied ${m.id}`);
  }
}
