import { Pool, type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, ResourceError } from './policy';

export function databasePool(url?: string, schema = 'public') {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid DATABASE_SCHEMA');
  if (!url) return null;
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10,
    connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000, statement_timeout: 5000 });
  pool.on('error', () => {});
  return pool;
}
export async function transaction<T>(pool: Pool | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) fail(503, 'RESOURCE_STORE_UNAVAILABLE');
  let client: PoolClient | undefined;
  try {
    client = await pool.connect(); await client.query('BEGIN');
    const result = await fn(client); await client.query('COMMIT'); return result;
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error instanceof ResourceError) throw error;
    return fail(503, 'RESOURCE_STORE_UNAVAILABLE');
  } finally { client?.release(); }
}
export async function migrate(url?: string, schema = 'public') {
  const pool = databasePool(url, schema);
  try {
    await transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(72103)");
      await client.query('CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, sha256 text NOT NULL)');
      const directory = join(__dirname, '../migrations');
      for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
        const sql = await readFile(join(directory, name), 'utf8');
        const hash = createHash('sha256').update(sql).digest('hex');
        const existing = await client.query('SELECT sha256 FROM schema_migration WHERE name=$1', [name]);
        if (existing.rowCount) { if (existing.rows[0].sha256 !== hash) throw new Error('Migration checksum mismatch'); continue; }
        await client.query(sql);
        await client.query('INSERT INTO schema_migration VALUES ($1,$2)', [name, hash]);
      }
    });
  } finally { await pool?.end(); }
}
