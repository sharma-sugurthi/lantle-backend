import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const isLocal = /localhost|127\.0\.0\.1/.test(config.databaseUrl);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
});

export const q = <T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) => pool.query<T>(text, params);

export async function migrate(): Promise<void> {
  await q('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const dir = path.resolve(process.cwd(), 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await q<{ name: string }>('select name from schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [f]);
      await client.query('commit');
      console.log(`[migrate] applied ${f}`);
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }
}
