// `hedgehog friction add`/`list`/`resolve` — the `friction` table and the
// committed record behind each of its rows.
//
// The DB is gitignored and rebuildable, so every friction entry also lives
// in `.hedgehog/friction/<key>.json`: one file per entry, holding the full
// row (task, note, logged_at, resolution). `hedgehog db rebuild` clears the
// table and replays it from these files (replayFriction), the same way it
// replays debt and decision notes from `.hedgehog/notes/` (notes.mjs). A
// fresh clone or a deleted DB therefore lists the same friction, open and
// resolved, once the records are committed.
//
// A record logged inside a worktree is an untracked file there, and verify
// never commits it. `hedgehog merge` and `hedgehog abandon` carry those
// records into the trunk checkout before removing the worktree
// (carryFrictionRecords), so friction logged in a worktree reaches trunk
// whether the intent ships or is dropped.
//
// Friction does not fit notes.mjs's one-file-per-task shape: its task is
// optional, an entry outlives its task (the row is kept unattached rather
// than dropped), and `resolve` addresses a single entry. One file per
// entry also means two worktrees logging friction never edit the same
// file, so their merge never conflicts on it.
//
// `<key>` is derived from the entry's own logged_at and note
// (frictionKey), not from the DB's row id, which differs between DBs. A
// DB row and its record are matched by that key. Row ids are assigned per
// DB, so a `friction resolve` id comes from a `friction list` run after
// the last rebuild or merge.
//
// Two kinds of DB row have no record. A row whose logged_at is SQLite's
// `datetime('now')` form (`YYYY-MM-DD HH:MM:SS`, no `T`) was written
// without one; `friction add`, `list`, and `resolve` write it a record
// (syncFrictionRecords), and `db rebuild` keeps it as it is until then. A
// row whose logged_at is ISO (`T`) had a record that was deleted; rebuild
// and sync drop it.
//
// `.hedgehog/friction/log.md`, where present, is not read or written.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const FRICTION_DIR = '.hedgehog/friction';

export function frictionKey({ loggedAt, note }) {
  return createHash('sha256').update(`${loggedAt}\0${note}`).digest('hex').slice(0, 16);
}

function hasNoRecordFormat(loggedAt) {
  return !loggedAt.includes('T');
}

// SQLite's `datetime('now')` form is UTC with no zone marker; Date.parse
// would read it as local time.
function timeOf(loggedAt) {
  const iso = hasNoRecordFormat(loggedAt) ? `${loggedAt.replace(' ', 'T')}Z` : loggedAt;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function byLoggedAt(a, b) {
  return timeOf(a.loggedAt) - timeOf(b.loggedAt) || frictionKey(a).localeCompare(frictionKey(b));
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

async function readFrictionRecord(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`could not read friction record ${path}: ${err.message}`, { cause: err });
  }
  return validateFrictionRecord(parsed, path);
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
    const entry = await readFrictionRecord(path);
    records.set(frictionKey(entry), { path, entry });
  }
  return records;
}

// Temp file + rename, so a crash mid-write never leaves a half-written
// record for loadFrictionRecords to trip on.
async function writeFrictionRecord(entry, path, frictionDir = FRICTION_DIR) {
  const target = path ?? `${frictionDir}/${frictionKey(entry)}.json`;
  const record = {
    task: entry.taskId ?? null,
    note: entry.note,
    logged_at: entry.loggedAt,
    resolved_at: entry.resolvedAt ?? null,
    resolved_reason: entry.resolvedReason ?? null,
  };
  await mkdir(dirname(target), { recursive: true });
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

const insertFrictionRow = (db) =>
  db.prepare(
    `INSERT INTO friction (task_id, note, logged_at, resolved_at, resolved_reason)
     VALUES (?, ?, ?, ?, ?)`,
  );

// Brings the DB and the records into line without renumbering rows: a row
// in `datetime('now')` form with no record gets one written, an ISO row
// with no record is deleted, and a record with no row gets one inserted
// (a record that arrived by `git pull` or a worktree carry).
export async function syncFrictionRecords(db, frictionDir = FRICTION_DIR) {
  const records = await loadFrictionRecords(frictionDir);
  const rowKeys = new Set();
  const deleteRow = db.prepare('DELETE FROM friction WHERE id = ?');
  for (const row of frictionRows(db)) {
    const key = frictionKey(row);
    rowKeys.add(key);
    if (records.has(key)) continue;
    if (hasNoRecordFormat(row.loggedAt)) {
      await writeFrictionRecord(row, null, frictionDir);
    } else {
      deleteRow.run(row.id);
    }
  }
  const taskExists = db.prepare('SELECT 1 FROM tasks WHERE id = ?');
  const insert = insertFrictionRow(db);
  const missing = [...records]
    .filter(([key]) => !rowKeys.has(key))
    .map(([, { entry }]) => entry)
    .sort(byLoggedAt);
  for (const entry of missing) {
    const taskId = entry.taskId && taskExists.get(entry.taskId) !== undefined ? entry.taskId : null;
    insert.run(taskId, entry.note, entry.loggedAt, entry.resolvedAt, entry.resolvedReason);
  }
}

// Rows in `datetime('now')` form with no record, read before rebuild
// clears anything, so replayFriction can keep them. Each keeps the task_id
// it held before the clear detached it.
export function frictionRowsWithoutRecords(db, records) {
  return frictionRows(db).filter(
    (row) => hasNoRecordFormat(row.loggedAt) && !records.has(frictionKey(row)),
  );
}

// Replaces the `friction` table with `records` plus `unrecorded` rows, in
// logged_at order. An entry whose task is not in the rebuilt graph is kept
// with a null task_id and returned as orphaned; its record is rewritten
// with the null task, so the next rebuild does not report it again.
export async function replayFriction(db, records, unrecorded = []) {
  const entries = [
    ...[...records.values()].map(({ path, entry }) => ({ ...entry, path })),
    ...unrecorded,
  ].sort(byLoggedAt);
  const taskExists = db.prepare('SELECT 1 FROM tasks WHERE id = ?');
  const insert = insertFrictionRow(db);
  const orphaned = [];
  db.prepare('DELETE FROM friction').run();
  for (const entry of entries) {
    let taskId = entry.taskId ?? null;
    if (taskId && taskExists.get(taskId) === undefined) {
      orphaned.push({ kind: 'friction', taskId, note: entry.note });
      taskId = null;
      if (entry.path) await writeFrictionRecord({ ...entry, taskId: null }, entry.path);
    }
    insert.run(taskId, entry.note, entry.loggedAt, entry.resolvedAt ?? null, entry.resolvedReason ?? null);
  }
  return orphaned;
}

// Copies the friction records that are untracked or modified in the
// checkout at `fromRoot` into the one at `toRoot`, then restores
// `fromRoot`'s copies so its tree is clean for `git worktree remove`. A
// record present on both sides keeps trunk's copy unless only the incoming
// one is resolved. Returns the carried paths.
export async function carryFrictionRecords(fromRoot, toRoot) {
  const status = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--', FRICTION_DIR],
    { cwd: fromRoot, encoding: 'utf8', stdio: 'pipe' },
  );
  const carried = [];
  for (const line of status.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3);
    if (!path.endsWith('.json') || code.includes('D')) continue;

    const incoming = await readFrictionRecord(join(fromRoot, path));
    const target = join(toRoot, path);
    const existing = existsSync(target) ? await readFrictionRecord(target) : null;
    if (!existing || (incoming.resolvedAt && !existing.resolvedAt)) {
      await writeFrictionRecord(incoming, target);
    }
    carried.push(path);

    let inHead = true;
    try {
      execFileSync('git', ['cat-file', '-e', `HEAD:${path}`], { cwd: fromRoot, stdio: 'pipe' });
    } catch {
      inHead = false;
    }
    if (inHead) {
      execFileSync('git', ['checkout', 'HEAD', '--', path], { cwd: fromRoot, stdio: 'pipe' });
    } else {
      execFileSync('git', ['rm', '-q', '--cached', '--ignore-unmatch', '--', path], { cwd: fromRoot, stdio: 'pipe' });
      await rm(join(fromRoot, path), { force: true });
    }
  }
  return carried;
}

// Writes one friction entry: committed record first, then the DB row, so a
// failed write records nothing that the next rebuild would not replay.
// `taskId` is optional; the schema's task_id is nullable. Two entries with
// the same note in the same millisecond would share a key, so logged_at is
// moved forward a millisecond at a time until the key is free.
export async function addFriction(db, { note, taskId }, frictionDir = FRICTION_DIR) {
  if (!note) throw new Error('friction requires a note');
  await syncFrictionRecords(db, frictionDir);

  let time = Date.now();
  const entryAt = (ms) => ({ taskId: taskId ?? null, note, loggedAt: new Date(ms).toISOString() });
  while (existsSync(`${frictionDir}/${frictionKey(entryAt(time))}.json`)) time++;
  const entry = entryAt(time);

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
  const rows = frictionRows(db).sort((a, b) => byLoggedAt(a, b) || a.id - b.id);
  return includeResolved ? rows : rows.filter((row) => row.resolvedAt == null);
}

// Resolves one friction row by id: rewrites its record with the resolution,
// then marks the row resolved.
export async function resolveFriction(db, { frictionId, reason }, frictionDir = FRICTION_DIR) {
  if (!frictionId) throw new Error('friction resolve requires a friction id');
  if (!reason) throw new Error('friction resolve requires a --reason');

  await syncFrictionRecords(db, frictionDir);
  const row = frictionRows(db).find((r) => r.id === frictionId);
  if (!row) throw new Error(`no such friction entry: #${frictionId}`);
  if (row.resolvedAt) throw new Error(`friction #${frictionId} is already resolved`);

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
