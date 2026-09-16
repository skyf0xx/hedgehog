// `.hedgehog/noop/<task-id>.json` — the committed record behind a task
// verify.mjs closes `complete` without a git commit, because its scope had
// nothing left to touch before verify_command even ran.
//
// A completed task is normally recoverable on `hedgehog db rebuild`
// because its own commit's subject matches its `commit_message`
// (rebuild.mjs#markCompletedTasks). A task closed with no commit at all
// has nothing there to match, so — the same gap reconcile.mjs closes for a
// hand-written commit that doesn't match — this file is the committed
// source rebuild.mjs replays instead.
//
// One file per task, written once: a task closes as a no-op at most once,
// the same reason reconcile.mjs's record refuses to overwrite rather than
// growing like notes.mjs's does.

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

  return { task, commit_message: commitMessage, verified_at: verifiedAt };
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
// reconcile.mjs#writeReconciledFile's pattern, applied to the same
// one-shot-per-task shape.
//
// Refuses to overwrite silently: a task closes no-op once, and a second
// attempt for the same id is a wrong id or a re-run worth stopping for,
// not a second distinct fact.
export async function writeNoopFile(record, noopDir = NOOP_DIR) {
  const path = noopFilePath(record.task, noopDir);
  try {
    await readFile(path, 'utf8');
    throw new Error(`${path} already exists — ${record.task} is already recorded as a no-op completion.`);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
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

// No-op-record task ids matching no row in `tasks` — same read-side
// hygiene as reconcile.mjs#orphanedReconciliations: a dead record must
// stay discoverable rather than silently completing nothing forever.
export function orphanedNoopRecords(db, records) {
  const known = new Set(db.prepare('SELECT id FROM tasks').all().map((r) => r.id));
  return [...records.keys()].filter((taskId) => !known.has(taskId)).sort();
}
