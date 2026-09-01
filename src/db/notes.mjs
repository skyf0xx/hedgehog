// `.hedgehog/notes/<task-id>.json` — the committed record behind `debt`
// and `decisions` rows.
//
// Both tables are operator- or agent-recorded notes with no committed
// source, in the same position `.hedgehog/reconciled/*.json` was in
// before reconcile.mjs existed: the only place they live is the DB, and
// `hedgehog db rebuild` clears and re-derives the DB from committed files
// on every run (rebuild.mjs#clearDerivedGraph). Before this file existed,
// rebuild carried debt/decisions across by reading them out of the *same*
// DB it was about to wipe — which only works because today there is
// always exactly one DB. A worktree gets its own DB with no memory of
// what a sibling worktree's DB held, so a note logged there and merged
// back has nothing for a post-merge rebuild to carry across, and is
// silently dropped. This file gives both tables the committed source
// `friction` already has (`.hedgehog/friction/log.md`) and `reconciled`
// records have (`.hedgehog/reconciled/*.json`), so a rebuild anywhere —
// worktree or trunk — replays the same notes from the same files.
//
// One file per task, holding every debt and decision note logged against
// it — unlike a reconciliation, which is one-shot per task, `debt add`
// and `decision add` are routinely called more than once against the same
// task, so the file is a list, not a single record, and a write appends
// rather than refusing to overwrite.

import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';

export const NOTES_DIR = '.hedgehog/notes';

function notesFilePath(taskId, notesDir = NOTES_DIR) {
  return `${notesDir}/${taskId.toLowerCase()}.json`;
}

function validateNotesFile(record, path) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`${path}: notes file must be a JSON object`);
  }
  const { task, notes } = record;
  if (!task || typeof task !== 'string') {
    throw new Error(`${path}: notes file requires a "task" id (string)`);
  }
  if (!Array.isArray(notes)) {
    throw new Error(`${path}: notes file requires a "notes" array`);
  }
  for (const entry of notes) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`${path}: notes file "${task}" has a non-object entry in notes`);
    }
    if (entry.kind !== 'debt' && entry.kind !== 'decision') {
      throw new Error(
        `${path}: notes file "${task}" has an entry with kind "${entry.kind}" — expected "debt" or "decision"`,
      );
    }
    if (!entry.note || typeof entry.note !== 'string') {
      throw new Error(`${path}: notes file "${task}" has an entry with no "note" (string)`);
    }
    if (!entry.logged_at || typeof entry.logged_at !== 'string') {
      throw new Error(`${path}: notes file "${task}" has an entry with no "logged_at" timestamp`);
    }
  }
  return { task: task.toUpperCase(), notes };
}

// Every notes file in `notesDir`, validated, as a Map from task id to its
// full { debt: [], decisions: [] } note list — the shape rebuild.mjs
// replays directly. Absent directory reads as "no notes recorded", the
// same way overrides.mjs#loadOverrides treats a missing directory.
export async function loadNotes(notesDir = NOTES_DIR) {
  let entries;
  try {
    entries = await readdir(notesDir);
  } catch {
    return new Map();
  }

  const byTask = new Map();
  for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
    const path = `${notesDir}/${name}`;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      throw new Error(`could not read notes file ${path}: ${err.message}`, { cause: err });
    }
    const { task, notes } = validateNotesFile(parsed, path);
    byTask.set(task, notes);
  }
  return byTask;
}

// Appends one note to `taskId`'s file, creating it if this is the task's
// first. Read-modify-write via temp file + rename, so a crash mid-write
// never leaves a half-written file for loadNotes to trip on —
// reconcile.mjs#writeReconciledFile's pattern, applied to a file that
// grows instead of one written once.
export async function appendNote(taskId, { kind, note, loggedAt }, notesDir = NOTES_DIR) {
  const path = notesFilePath(taskId, notesDir);

  let existing = [];
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    existing = validateNotesFile(parsed, path).notes;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  const record = {
    task: taskId.toUpperCase(),
    notes: [...existing, { kind, note, logged_at: loggedAt }],
  };

  await mkdir(notesDir, { recursive: true });
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
