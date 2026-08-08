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
import { planTasks, CORE_MODULE } from './plan.mjs';
import { loadCore } from './core.mjs';

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

// Every commit subject in history mapped to its position, newest first —
// one `git log` call rather than one per task. Membership alone answers
// "did this task ever run"; position also answers "did it run *after*
// the thing it depends on", which is what a `once: true` task needs,
// since its commit subject is a constant that one historical occurrence
// would otherwise satisfy forever. `--topo-order` so the position is a
// property of the history's shape rather than of commit timestamps.
function loadCommitSubjects() {
  const output = execSync('git log --topo-order --format=%H%x00%s', { encoding: 'utf8' });
  const newestPosition = new Map();
  let position = 0;
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [, subject] = line.split('\0');
    if (subject === undefined) continue;
    // Newest first, so the first occurrence seen is the most recent one.
    if (!newestPosition.has(subject)) newestPosition.set(subject, position);
    position++;
  }
  return newestPosition;
}

// A task is complete iff some commit's subject exactly matches its
// commit_message — the same message verifyTask used when it made that
// commit. Marks status directly rather than through verifyTask's flow:
// there's no verify_command to re-run and no working tree diff to check,
// only the historical fact that the commit already happened.
//
// A `once: true` task carries two extra conditions: every prerequisite
// must be complete, and its own commit must be *newer* than all of them.
// Its prerequisite set is the only one that grows after the task has
// already run — `planner`'s Re-entry pass adds a new intent whose work a
// tail once-layer then depends on (plan.mjs reopens it for exactly that
// reason). Its commit subject carries no {module}, so it is a constant:
// the single `chore(infra): deploy` from the first run would otherwise
// make the layer look done forever, re-closing it here on the next fresh
// clone and quietly undoing the reopen. Requiring it to sit above its
// prerequisites in history is what encodes "the deploy ran *after* that
// module landed". Walked to a fixpoint, since a once-layer may sit
// behind another one.
//
// This condition is deliberately not applied to per-module tasks. A task
// that completed without touching any file leaves no commit at all
// (verifyTask writes none), and cascading that gap through the whole
// chain would reset already-built modules. Scoping it to once-layers
// keeps the change to cores that use the feature, and errs toward
// re-running an idempotent infrastructure step rather than skipping it.
function markCompletedTasks(db, commitSubjects) {
  const tasks = db.prepare('SELECT id, module, commit_message FROM tasks').all();
  const prerequisites = new Map(tasks.map((t) => [t.id, []]));
  for (const d of db.prepare('SELECT task_id, depends_on_task_id FROM dependencies').all()) {
    prerequisites.get(d.task_id)?.push(d.depends_on_task_id);
  }

  // Position of each task's most recent matching commit; undefined means
  // the task never committed.
  const positionOf = new Map(
    tasks.map((t) => [t.id, commitSubjects.get(t.commit_message)]),
  );

  const complete = new Set();
  const onceTasks = [];
  for (const task of tasks) {
    if (task.module === CORE_MODULE) {
      onceTasks.push(task);
      continue;
    }
    if (positionOf.get(task.id) !== undefined) complete.add(task.id);
  }

  // Lower position is newer, so a once-task ran after a prerequisite when
  // its own position is strictly smaller.
  const ranAfterPrerequisites = (task) => {
    const own = positionOf.get(task.id);
    return prerequisites.get(task.id).every((id) => {
      const prereq = positionOf.get(id);
      return prereq === undefined || own < prereq;
    });
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const task of onceTasks) {
      if (complete.has(task.id) || positionOf.get(task.id) === undefined) continue;
      if (!prerequisites.get(task.id).every((id) => complete.has(id))) continue;
      if (!ranAfterPrerequisites(task)) continue;
      complete.add(task.id);
      changed = true;
    }
  }

  const setComplete = db.prepare("UPDATE tasks SET status = 'complete' WHERE id = ?");
  for (const id of complete) setComplete.run(id);

  // Rebuild also runs against an already-populated DB ("after suspected
  // corruption"), where a once-task may be sitting at `complete` from
  // before a re-entry pass added work under it. Reconcile it back rather
  // than leaving the stale status untouched.
  const reopen = db.prepare(
    "UPDATE tasks SET status = 'planned' WHERE id = ? AND status = 'complete'",
  );
  for (const task of onceTasks) {
    if (!complete.has(task.id)) reopen.run(task.id);
  }

  return complete.size;
}

// Rebuilds `db` from scratch: schema, then every committed intent
// replayed through addIntent, then planTasks to re-derive tasks +
// dependencies, then git history to reconcile which tasks already
// completed. Returns a summary for the CLI to print.
export async function rebuildDb(db, { corePath, intentsDir = INTENTS_DIR } = {}) {
  applySchema(db);

  const intentsReplayed = await replayIntents(db, intentsDir);

  const core = await loadCore(corePath);
  planTasks(db, core);

  const commitSubjects = loadCommitSubjects();
  const tasksMarkedComplete = markCompletedTasks(db, commitSubjects);

  return { intentsReplayed, tasksMarkedComplete };
}
