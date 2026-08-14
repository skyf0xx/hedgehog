import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadEnv } from 'config';

/**
 * Shared Drizzle client (Postgres via `pg`). Reads `DATABASE_URL` through
 * `loadEnv()` — boot fails fast on a missing/malformed connection string
 * rather than surfacing as a runtime connection error.
 *
 * No domain schema is registered here — each module's own schema lives in
 * `libs/<module>/repository` (Phase A) and is passed in via `withSchema`
 * (or attached at the call site), keeping this package schema-agnostic
 * infra rather than a place domain modules reach into directly.
 */

let pool: Pool | undefined;
let client: NodePgDatabase | undefined;

export function getPool(): Pool {
  if (!pool) {
    const env = loadEnv();
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      // A wedged connection surfaces as a query error rather than a hang.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    // `pg` emits 'error' on the pool when an *idle* client's connection dies
    // (Postgres restart, failover, laptop sleep). Node terminates the process
    // on an unhandled 'error' event, so without this listener a routine
    // database blip crashes the API. `pg` has already discarded the bad
    // client by the time this fires: the next query opens a fresh connection,
    // so logging and swallowing is the recovery.
    pool.on('error', (err) => {
      console.error('idle postgres client error', err);
    });
  }
  return pool;
}

export function getDb(): NodePgDatabase {
  if (!client) {
    client = drizzle(getPool());
  }
  return client;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    client = undefined;
  }
}
