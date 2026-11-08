import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config';
import type { Vault } from './crypto';

export const DEFAULT_WS = 'default';
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function connect(vault: Vault, retries = 30): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  for (let i = 0; ; i++) {          // compose starts db and app together; wait for db
    try { await pool.query('select 1'); break; }
    catch (e) { if (i >= retries) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');
  await pool.query('select pg_advisory_lock(7141)');
  try {
    await pool.query(sql);
    await pool.query(
      `insert into workspaces (id, name, owner_id, wrapped_key) values ($1,$2,$3,$4) on conflict do nothing`,
      [DEFAULT_WS, 'My workspace', 'owner', vault.newWorkspaceKey()]);
    if (config.adminToken) {
      await pool.query(
        `insert into api_tokens (token_hash, workspace_id, name, scope) values ($1,$2,'bootstrap admin','admin') on conflict do nothing`,
        [hashToken(config.adminToken), DEFAULT_WS]);
    }
  } finally { await pool.query('select pg_advisory_unlock(7141)'); }
  return pool;
}
