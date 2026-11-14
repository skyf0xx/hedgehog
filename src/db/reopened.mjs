// `.hedgehog/reopened/<task-id>.json` — the committed record of a task
// `hedgehog reopen` sent back to `planned` that has not verified again yet.
//
// A reopened task keeps its original commit (or no-op record) in history,
// so without this record `hedgehog db rebuild` would mark it `complete`
// again from that commit mid-correction. rebuild.mjs replays these records
// after every completion source, forcing each named task back to
// `planned`. verify.mjs also reads the record as proof the task is a
// re-verification, so its verify command runs even with nothing in scope,
// and removes it once the task closes `complete` again.

import { readdir, mkdir, writeFile, rename, rm, access } from 'node:fs/promises';

export const REOPENED_DIR = '.hedgehog/reopened';

function reopenedFilePath(taskId, reopenedDir) {
  return `${reopenedDir}/${taskId.toLowerCase()}.json`;
}

export async function writeReopenedRecords(taskIds, reopenedDir = REOPENED_DIR) {
  if (taskIds.length === 0) return;
  await mkdir(reopenedDir, { recursive: true });
  const reopenedAt = new Date().toISOString();
  for (const task of taskIds) {
    const path = reopenedFilePath(task, reopenedDir);
    const tempPath = `${path}.tmp-${process.pid}`;
    try {
      await writeFile(tempPath, `${JSON.stringify({ task, reopened_at: reopenedAt }, null, 2)}\n`);
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

export async function hasReopenedRecord(taskId, reopenedDir = REOPENED_DIR) {
  try {
    await access(reopenedFilePath(taskId, reopenedDir));
    return true;
  } catch {
    return false;
  }
}

export async function clearReopenedRecord(taskId, reopenedDir = REOPENED_DIR) {
  await rm(reopenedFilePath(taskId, reopenedDir), { force: true });
}
