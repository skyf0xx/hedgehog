// `hedgehog db rebuild` — reconstructs the build graph from committed
// source-of-truth files, for a fresh clone (no `.hedgehog/hedgehog.db`)
// or after suspected corruption. The DB itself is a derived artifact:
// everything it holds is either replayable from `.hedgehog/intents/*.json`
// (via the same `addIntent`/`planTasks` path `intent add`/`plan` already
// use) or recoverable from git history (which tasks' commits already
// landed). What isn't recoverable — `verifications.output`, the ephemeral
// diagnostics of a run that already passed — is an accepted loss; this
// only reconciles `tasks.status`.

import { readdir, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { applySchema } from './schema.mjs';
import { addIntent, INTENTS_DIR } from './intent.mjs';
import { planTasks } from './plan.mjs';
import { loadCore } from './core.mjs';
import { detectDrift } from './drift.mjs';

// Alphabetical by filename so replay order is deterministic across
// machines and runs — intents have no other natural ordering (priority
// only matters once they're compiled into tasks by planTasks).
async function loadIntentFiles(intentsDir) {
  let entries;
  try {
    entries = await readdir(intentsDir);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith('.json')).sort();
}

function intentExists(db, id) {
  return db.prepare('SELECT 1 FROM intents WHERE id = ?').get(id) !== undefined;
}

// addIntent's INSERT is unconditional (an intent id is never re-added
// through `intent add` in normal use), so rebuild — the one caller that
// must also tolerate an already-populated DB, per "re-derive from
// source-of-truth after suspected corruption" — skips any intent file
// whose id is already present rather than letting the UNIQUE constraint
// fail the whole run.
async function replayIntents(db, intentsDir) {
  const files = await loadIntentFiles(intentsDir);
  let count = 0;
  for (const file of files) {
    const text = await readFile(`${intentsDir}/${file}`, 'utf8');
    const record = JSON.parse(text);
    if (intentExists(db, record.id)) continue;
    await addIntent(db, record);
    count++;
  }
  return count;
}

// Every commit subject in history, as a Set — one `git log` call rather
// than one per task, since the check below is pure membership.
function loadCommitSubjects() {
  const output = execSync('git log --format=%H%x00%s', { encoding: 'utf8' });
  const subjects = new Set();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [, subject] = line.split('\0');
    if (subject !== undefined) subjects.add(subject);
  }
  return subjects;
}

// A task is complete iff some commit's subject exactly matches its
// commit_message — the same message verifyTask used when it made that
// commit. Marks status directly rather than through verifyTask's flow:
// there's no verify_command to re-run and no working tree diff to check,
// only the historical fact that the commit already happened.
function markCompletedTasks(db, commitSubjects) {
  const tasks = db.prepare('SELECT id, commit_message FROM tasks').all();
  const setComplete = db.prepare("UPDATE tasks SET status = 'complete' WHERE id = ?");
  let count = 0;
  for (const task of tasks) {
    if (!commitSubjects.has(task.commit_message)) continue;
    setComplete.run(task.id);
    count++;
  }
  return count;
}

// Rebuilds `db` from scratch: schema, then every committed intent
// replayed through addIntent, then planTasks to re-derive tasks +
// dependencies, then git history to reconcile which tasks already
// completed. Returns a summary for the CLI to print.
//
// `drift` in the return is the honest disclosure this rebuild owes its
// caller. A rebuild re-derives every task's layer-derived fields from
// the *current* core.yaml, and the intent files it replays carry no
// task-level detail at all — so any hand-edit made directly to a task
// row (the widened scope glob, the patched verify command) has no
// committed source to replay from and does not survive. Rows that
// predate this rebuild are left as they are, which is the other half of
// the same problem: they can be stale against core.yaml and nothing
// would otherwise say so. Reporting the divergence is what turns both
// into something the operator sees instead of something they discover
// three layers later.
export async function rebuildDb(db, { corePath, intentsDir = INTENTS_DIR } = {}) {
  applySchema(db);

  const intentsReplayed = await replayIntents(db, intentsDir);

  const core = await loadCore(corePath);
  planTasks(db, core);

  const commitSubjects = loadCommitSubjects();
  const tasksMarkedComplete = markCompletedTasks(db, commitSubjects);

  const drift = detectDrift(db, core);

  return { intentsReplayed, tasksMarkedComplete, drift };
}
