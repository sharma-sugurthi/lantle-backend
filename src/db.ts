import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const isLocal = /localhost|127\.0\.0\.1/.test(config.databaseUrl);

/**
 * TLS for Postgres. With DATABASE_CA set the server certificate is verified against it. Without it (development only;
 * config.ts refuses to boot in production) the connection is encrypted but unverified, and says so once at boot.
 */
export function pgSsl(): pg.PoolConfig['ssl'] {
  if (isLocal) return undefined;
  if (config.databaseCa) return { ca: config.databaseCa, rejectUnauthorized: true };
  console.warn('[db] DATABASE_CA is not set: the Postgres connection is encrypted but the server certificate is NOT verified.');
  return { rejectUnauthorized: false };
}

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: pgSsl(),
  max: 5,
  idleTimeoutMillis: 30_000,
});

export const q = <T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) => pool.query<T>(text, params);

export async function migrate(): Promise<void> {
  await q('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const dir = path.resolve(process.cwd(), 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  // One session-level advisory lock so two dynos booting at once (restart, scale-up) never run the same migration twice.
  const lock = await pool.connect();
  try {
    await lock.query('select pg_advisory_lock(727001)');
    const { rows } = await lock.query<{ name: string }>('select name from schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      try {
        await lock.query('begin');
        await lock.query(sql);
        await lock.query('insert into schema_migrations (name) values ($1)', [f]);
        await lock.query('commit');
        console.log(`[migrate] applied ${f}`);
      } catch (e) {
        await lock.query('rollback');
        throw e;
      }
    }
  } finally {
    await lock.query('select pg_advisory_unlock(727001)').catch(() => undefined);
    lock.release();
  }
}
