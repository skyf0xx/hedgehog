// `.hedgehog/noop/<task-id>.json` — the committed record behind a task
// verify.mjs closes `complete` without a git commit, because its scope had
// nothing to touch (whether or not verify_command ran — see verify.mjs).
//
// A completed task is normally recoverable on `hedgehog db rebuild`
// because its own commit's subject matches its `commit_message`
// (rebuild.mjs#markCompletedTasks). A task closed with no commit at all
// has nothing there to match, so — the same gap reconcile.mjs closes for a
// hand-written commit that doesn't match — this file is the committed
// source rebuild.mjs replays instead.
//
// `verify_ran` says whether verify_command ran on that close. A reopened
// task re-runs its command on an empty re-verification only when an
// earlier close ran it (reopened.mjs).
//
// One file per task. A task reopened by `hedgehog reopen` can close as a
// no-op again; that rewrite refreshes the same record's `verified_at`
// rather than adding a second one. A file at that path naming a different
// task is refused.

import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';

export const NOOP_DIR = '.hedgehog/noop';

function noopFilePath(taskId, noopDir = NOOP_DIR) {
  return `${noopDir}/${taskId.toLowerCase()}.json`;
}

function validateNoop(record, path) {
  if (record === null || typeof record !== 'object') {
    throw new Error(`${path}: no-op record must be a JSON object`);
  }
  let { task } = record;
  const { commit_message: commitMessage, verified_at: verifiedAt } = record;

  if (!task || typeof task !== 'string') {
    throw new Error(`${path}: no-op record requires a "task" id (string)`);
  }
  task = task.toUpperCase();

  if (!commitMessage || typeof commitMessage !== 'string') {
    throw new Error(`${path}: no-op record "${task}" requires a "commit_message" (string)`);
  }
  if (!verifiedAt || typeof verifiedAt !== 'string') {
    throw new Error(`${path}: no-op record "${task}" requires a "verified_at" timestamp (string)`);
  }

  // Absent on a record from a close that never ran verify_command.
  const verifyRan = record.verify_ran === true;

  return { task, commit_message: commitMessage, verified_at: verifiedAt, verify_ran: verifyRan };
}

// Every *.json in `noopDir`, validated, as a Map from task id to its
// record. Absent directory reads as "nothing closed no-op" — the same
// convention overrides.mjs#loadOverrides and reconcile.mjs#loadReconciliations
// use for their own missing directories.
export async function loadNoopRecords(noopDir = NOOP_DIR) {
  let entries;
  try {
    entries = await readdir(noopDir);
  } catch {
    return new Map();
  }

  const byTask = new Map();
  for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
    const path = `${noopDir}/${name}`;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      throw new Error(`could not read no-op record ${path}: ${err.message}`, { cause: err });
    }
    const record = validateNoop(parsed, path);
    byTask.set(record.task, record);
  }
  return byTask;
}

// Writes one no-op record via temp file + rename, so a crash mid-write
// never leaves a half-written file for loadNoopRecords to trip on —
// reconcile.mjs#writeReconciledFile's pattern, one file per task.
//
// An existing record for the same task is replaced (a re-verification
// after `hedgehog reopen`); an existing file that is unreadable or names a
// different task is refused.
export async function writeNoopFile(record, noopDir = NOOP_DIR) {
  const path = noopFilePath(record.task, noopDir);
  let existing;
  try {
    existing = await readFile(path, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (existing !== undefined) {
    let existingTask;
    try {
      existingTask = validateNoop(JSON.parse(existing), path).task;
    } catch (err) {
      throw new Error(`${path} already exists and is not a valid no-op record: ${err.message}`, { cause: err });
    }
    if (existingTask !== record.task.toUpperCase()) {
      throw new Error(`${path} already exists and records ${existingTask}, not ${record.task}.`);
    }
  }

  await mkdir(noopDir, { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`);
    await rename(tempPath, path);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  return record;
}

// The validated record for `taskId`, or null when it has none.
export async function loadNoopRecord(taskId, noopDir = NOOP_DIR) {
  const path = noopFilePath(taskId, noopDir);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  return validateNoop(JSON.parse(raw), path);
}

// No-op-record task ids matching no row in `tasks` — same read-side
// hygiene as reconcile.mjs#orphanedReconciliations: a dead record must
// stay discoverable rather than silently completing nothing forever.
export function orphanedNoopRecords(db, records) {
  const known = new Set(db.prepare('SELECT id FROM tasks').all().map((r) => r.id));
  return [...records.keys()].filter((taskId) => !known.has(taskId)).sort();
}
