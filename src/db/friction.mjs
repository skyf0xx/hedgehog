// `hedgehog friction add`/`list`/`resolve` — the `friction` table and the
// committed record behind each of its rows.
//
// The DB is gitignored and rebuildable, so every friction entry also lives
// in `.hedgehog/friction/<key>.json`: one file per entry, holding the full
// row (task, note, logged_at, resolution). `hedgehog db rebuild` clears the
// table and replays it from these files (replayFriction), the same way it
// replays debt and decision notes from `.hedgehog/notes/` (notes.mjs). A
// fresh clone, a deleted DB, or a merged-back worktree therefore lists the
// same friction, open and resolved.
//
// Friction does not fit notes.mjs's one-file-per-task shape: its task is
// optional, an entry outlives its task (the row is kept unattached rather
// than dropped), and `resolve` addresses a single entry. One file per
// entry also means two worktrees logging friction never edit the same
// file, so their merge never conflicts on it.
//
// `<key>` is derived from the entry's own logged_at and note
// (frictionKey), not from the DB's row id, which differs between DBs. A
// DB row and its record are matched by that key, which is how
// backfillFrictionRecords finds a row that has no record yet (one logged
// before records existed) and writes it one. `friction add`, `list`, and
// `resolve` all run that backfill, so the first friction command on such
// a project puts every DB-only row on disk for the operator to commit.
// Until then `db rebuild` keeps a DB-only row as it is instead of
// dropping it.
//
// Older projects may also hold `.hedgehog/friction/log.md`. Nothing reads
// or writes it; the JSON records are the committed form.

import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';

export const FRICTION_DIR = '.hedgehog/friction';

export function frictionKey({ loggedAt, note }) {
  return createHash('sha256').update(`${loggedAt}\0${note}`).digest('hex').slice(0, 16);
}

function validateFrictionRecord(record, path) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`${path}: friction record must be a JSON object`);
  }
  const { task, note, logged_at: loggedAt, resolved_at: resolvedAt, resolved_reason: resolvedReason } =
    record;
  if (!note || typeof note !== 'string') throw new Error(`${path}: friction record requires a "note" (string)`);
  if (!loggedAt || typeof loggedAt !== 'string') {
    throw new Error(`${path}: friction record requires a "logged_at" timestamp`);
  }
  if (task != null && typeof task !== 'string') throw new Error(`${path}: friction "task" must be a string or null`);
  if (resolvedAt != null && typeof resolvedAt !== 'string') {
    throw new Error(`${path}: friction "resolved_at" must be a string or null`);
  }
  if (resolvedAt != null && (!resolvedReason || typeof resolvedReason !== 'string')) {
    throw new Error(`${path}: resolved friction record requires a "resolved_reason" (string)`);
  }
  return {
    taskId: task ? task.toUpperCase() : null,
    note,
    loggedAt,
    resolvedAt: resolvedAt ?? null,
    resolvedReason: resolvedAt != null ? resolvedReason : null,
  };
}

// Every record in `frictionDir` as a Map from frictionKey to
// { path, entry }. Absent directory reads as "no friction recorded".
export async function loadFrictionRecords(frictionDir = FRICTION_DIR) {
  let names;
  try {
    names = await readdir(frictionDir);
  } catch {
    return new Map();
  }
  const records = new Map();
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const path = `${frictionDir}/${name}`;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      throw new Error(`could not read friction record ${path}: ${err.message}`, { cause: err });
    }
    const entry = validateFrictionRecord(parsed, path);
    records.set(frictionKey(entry), { path, entry });
  }
  return records;
}

// Temp file + rename, so a crash mid-write never leaves a half-written
// record for loadFrictionRecords to trip on.
async function writeFrictionRecord(entry, path, frictionDir) {
  const target = path ?? `${frictionDir}/${frictionKey(entry)}.json`;
  const record = {
    task: entry.taskId ?? null,
    note: entry.note,
    logged_at: entry.loggedAt,
    resolved_at: entry.resolvedAt ?? null,
    resolved_reason: entry.resolvedReason ?? null,
  };
  await mkdir(frictionDir, { recursive: true });
  const tempPath = `${target}.tmp-${process.pid}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`);
    await rename(tempPath, target);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  return target;
}

function frictionRows(db) {
  return db
    .prepare(
      `SELECT id, task_id AS taskId, note, logged_at AS loggedAt,
              resolved_at AS resolvedAt, resolved_reason AS resolvedReason
       FROM friction ORDER BY id ASC`,
    )
    .all();
}

// Writes a record for every DB row that has none. Returns how many it wrote.
export async function backfillFrictionRecords(db, frictionDir = FRICTION_DIR) {
  const records = await loadFrictionRecords(frictionDir);
  let written = 0;
  for (const row of frictionRows(db)) {
    const key = frictionKey(row);
    if (records.has(key)) continue;
    const path = await writeFrictionRecord(row, null, frictionDir);
    records.set(key, { path, entry: row });
    written++;
  }
  return written;
}

// Rows with no record behind them, read before rebuild clears anything, so
// replayFriction can keep them. Each keeps the task_id it held before the
// clear detached it.
export function frictionRowsWithoutRecords(db, records) {
  return frictionRows(db).filter((row) => !records.has(frictionKey(row)));
}

// Replaces the `friction` table with `records` plus `unrecorded` rows, in
// logged_at order. An entry whose task is not in the rebuilt graph is kept
// with a null task_id and returned as orphaned.
export function replayFriction(db, records, unrecorded = []) {
  const entries = [...[...records.values()].map(({ entry }) => entry), ...unrecorded].sort(
    (a, b) => a.loggedAt.localeCompare(b.loggedAt) || frictionKey(a).localeCompare(frictionKey(b)),
  );
  const taskExists = db.prepare('SELECT 1 FROM tasks WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO friction (task_id, note, logged_at, resolved_at, resolved_reason)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const orphaned = [];
  db.prepare('DELETE FROM friction').run();
  for (const entry of entries) {
    let taskId = entry.taskId ?? null;
    if (taskId && taskExists.get(taskId) === undefined) {
      orphaned.push({ kind: 'friction', taskId, note: entry.note });
      taskId = null;
    }
    insert.run(taskId, entry.note, entry.loggedAt, entry.resolvedAt ?? null, entry.resolvedReason ?? null);
  }
  return orphaned;
}

// Writes one friction entry: committed record first, then the DB row, so a
// failed write records nothing that the next rebuild would not replay.
// `taskId` is optional; the schema's task_id is nullable.
export async function addFriction(db, { note, taskId }, frictionDir = FRICTION_DIR) {
  if (!note) throw new Error('friction requires a note');
  await backfillFrictionRecords(db, frictionDir);

  const entry = { taskId: taskId ?? null, note, loggedAt: new Date().toISOString() };
  await writeFrictionRecord(entry, null, frictionDir);
  const result = db
    .prepare('INSERT INTO friction (task_id, note, logged_at) VALUES (?, ?, ?)')
    .run(entry.taskId, note, entry.loggedAt);

  return { id: Number(result.lastInsertRowid), taskId: entry.taskId, note };
}

// Every friction row, oldest first. Resolved rows are excluded by default
// (listDebt's convention) and included when `includeResolved` is set
// (`--all`).
export function listFriction(db, { includeResolved = false } = {}) {
  const rows = frictionRows(db);
  return includeResolved ? rows : rows.filter((row) => row.resolvedAt == null);
}

// Resolves one friction row by id: rewrites its record with the resolution,
// then marks the row resolved.
export async function resolveFriction(db, { frictionId, reason }, frictionDir = FRICTION_DIR) {
  if (!frictionId) throw new Error('friction resolve requires a friction id');
  if (!reason) throw new Error('friction resolve requires a --reason');

  const row = frictionRows(db).find((r) => r.id === frictionId);
  if (!row) throw new Error(`no such friction entry: #${frictionId}`);
  if (row.resolvedAt) throw new Error(`friction #${frictionId} is already resolved`);

  await backfillFrictionRecords(db, frictionDir);
  const records = await loadFrictionRecords(frictionDir);
  const existing = records.get(frictionKey(row));

  const resolvedAt = new Date().toISOString();
  await writeFrictionRecord(
    { ...(existing?.entry ?? row), resolvedAt, resolvedReason: reason },
    existing?.path ?? null,
    frictionDir,
  );
  db.prepare('UPDATE friction SET resolved_at = ?, resolved_reason = ? WHERE id = ?').run(
    resolvedAt,
    reason,
    frictionId,
  );

  return { id: row.id, taskId: row.taskId, note: row.note, resolvedAt, resolvedReason: reason };
}
