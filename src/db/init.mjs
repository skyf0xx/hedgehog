// `hedgehog db init` — creates .hedgehog/hedgehog.db if absent, no-ops if
// present. See hedgehog-persistent-build-graph.md, "The CLI is the only
// writer".

import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { applySchema } from './schema.mjs';

export const DB_PATH = '.hedgehog/hedgehog.db';

const exists = (p) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

export const dbAbsPath = (root = process.cwd()) => resolve(root, DB_PATH);

// One place every CLI command opens the build graph from, so the
// per-connection pragmas below (busy_timeout, WAL) are never skipped at
// a call site that forgot them. journal_mode is skipped for read-only
// handles — it requires write access and a readOnly connection has no
// business changing the file's journal mode anyway.
//
// applySchema also runs here, not only from `dbInit`: a graph created by
// an older CLI version is missing whatever tables/columns shipped since,
// and every command besides `init`/`update` opens the graph straight
// from here rather than going through dbInit first. Without this, those
// commands only see the fix after someone thinks to rerun `init` on an
// already-initialized project — which nothing prompts them to do — and
// until then every query naming a newer column fails with "no such
// column". Skipped for read-only handles for the same reason
// journal_mode is: it requires write access, and a readOnly caller is
// only ever reached after a writable open earlier in the same command.
export function openDb({ readOnly = false } = {}) {
  const db = new DatabaseSync(dbAbsPath(), { readOnly });
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 10000');
  if (!readOnly) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  if (!readOnly) applySchema(db);
  return db;
}

export function withDb(fn, opts) {
  const db = openDb(opts);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// openDb's cwd-relative counterpart for the one caller that has to open a
// build graph that is deliberately not the one `process.cwd()` names:
// `hedgehog merge` reads a worktree's own `.hedgehog/hedgehog.db` (its
// completeness check) while running from trunk's checkout. Same pragmas,
// same schema-apply-on-writable-open contract as openDb — the only
// difference is the path is given rather than resolved from DB_PATH.
export function openDbAt(absPath, { readOnly = false } = {}) {
  const db = new DatabaseSync(absPath, { readOnly });
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 10000');
  if (!readOnly) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  if (!readOnly) applySchema(db);
  return db;
}

// BEGIN IMMEDIATE rather than a bare BEGIN: acquires the write lock up
// front instead of on the first write statement, so two concurrent
// writers fail fast with SQLITE_BUSY (retried via busy_timeout) instead
// of deadlocking each other mid-transaction.
export function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback failing must not mask the original error.
    }
    throw err;
  }
}

// Returns { created: boolean, path } — created is false when the DB file
// already existed (no-op per the spec).
export async function dbInit(dbPath = DB_PATH) {
  const already = await exists(dbPath);
  await mkdir(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    // Applied unconditionally, not only on creation: the schema is all
    // `CREATE TABLE IF NOT EXISTS`, so re-running it against an existing
    // graph is a no-op for tables that are already there and the
    // migration path for ones added since that graph was created (the
    // `debt` table, for instance). `created` still reports whether the
    // file itself is new.
    applySchema(db);
  } finally {
    db.close();
  }

  return { created: !already, path: dbPath };
}
