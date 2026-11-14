// `.hedgehog/reopened/<task-id>.json` — the record of a task `hedgehog
// reopen` sent back to `planned` that has not verified again yet. The
// engine writes these files; the user commits them with the rest of
// `.hedgehog/`.
//
// A reopened task keeps its original commit (or no-op record) in history,
// so without this record `hedgehog db rebuild` would mark it `complete`
// again from that commit mid-correction. rebuild.mjs replays these records
// after every completion source, forcing each named task back to
// `planned`. verify.mjs removes the record once the task closes
// `complete` again.
//
// `verify_ran` records whether the task's earlier close ran its verify
// command (a commit close, or a no-op close that ran the check). Only then
// does an empty re-verification run the command again. A layer that first
// closed as an empty no-op may have a command with nothing to run against
// (a test filter matching no files exits nonzero), so it closes as an
// empty no-op again.

import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';

export const REOPENED_DIR = '.hedgehog/reopened';

function reopenedFilePath(taskId, reopenedDir) {
  return `${reopenedDir}/${taskId.toLowerCase()}.json`;
}

// `entries`: `[{ task, verify_ran }]`, one per reopened task.
export async function writeReopenedRecords(entries, reopenedDir = REOPENED_DIR) {
  if (entries.length === 0) return;
  await mkdir(reopenedDir, { recursive: true });
  const reopenedAt = new Date().toISOString();
  for (const { task, verify_ran: verifyRan } of entries) {
    const path = reopenedFilePath(task, reopenedDir);
    const tempPath = `${path}.tmp-${process.pid}`;
    const record = { task, verify_ran: verifyRan === true, reopened_at: reopenedAt };
    try {
      await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`);
      await rename(tempPath, path);
    } catch (err) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw err;
    }
  }
}

// Upper-cased task ids, matching how every other record dir keys its tasks.
export async function loadReopenedIds(reopenedDir = REOPENED_DIR) {
  let entries;
  try {
    entries = await readdir(reopenedDir);
  } catch {
    return new Set();
  }
  return new Set(
    entries.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length).toUpperCase()),
  );
}

// True when `taskId` has a reopen record whose earlier close ran its
// verify command.
export async function reopenedAfterCheckRan(taskId, reopenedDir = REOPENED_DIR) {
  let raw;
  try {
    raw = await readFile(reopenedFilePath(taskId, reopenedDir), 'utf8');
  } catch {
    return false;
  }
  try {
    return JSON.parse(raw).verify_ran === true;
  } catch {
    return false;
  }
}

export async function clearReopenedRecord(taskId, reopenedDir = REOPENED_DIR) {
  await rm(reopenedFilePath(taskId, reopenedDir), { force: true });
}
