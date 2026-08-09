// `hedgehog db rebuild` — reconstructs the build graph from committed
// source-of-truth files, for a fresh clone (no `.hedgehog/hedgehog.db`)
// or after suspected corruption. The DB itself is a derived artifact:
// everything it holds is either replayable from `.hedgehog/intents/*.json`
// (via the same normalize/insert path `intent add`/`plan` already use) or
// recoverable from git history (which tasks' commits already landed).
// What isn't recoverable — `verifications.output`, the ephemeral
// diagnostics of a run that already passed — is an accepted loss; this
// only reconciles `tasks.status`.
//
// A rebuild READS the permanent record. It never writes it: replay goes
// through `insertIntentRows`, not `addIntent`, so no intent file is
// touched even on a failed run. That matters because this path also
// fires automatically when the DB is missing (bin/cli.mjs#ensureDb) — a
// user who never typed `db rebuild` must not be able to lose planning to
// it.

import { readdir, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { applySchema } from './schema.mjs';
import { normalizeIntent, insertIntentRows, INTENTS_DIR } from './intent.mjs';
import { planTasks, CORE_MODULE } from './plan.mjs';
import { loadCore } from './core.mjs';
import { detectDrift } from './drift.mjs';
import { loadOverrides, OVERRIDES_DIR } from './overrides.mjs';

// Alphabetical by filename, purely to make the *tie-break* deterministic
// across machines and runs. It is NOT the replay order — see
// orderIntentsForReplay: `intent_dependencies` rows have a FOREIGN KEY
// onto `intents`, so an intent has to be inserted after everything it
// depends_on regardless of what its filename sorts as.
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

// Topological sort over `depends_on`, tie-broken by the file order above
// so two runs over the same directory always replay identically.
//
// An id that is depended on but has neither a file nor an existing row is
// named outright rather than left to surface as "FOREIGN KEY constraint
// failed" — the same goes for a genuine cycle, which no order can
// satisfy.
function orderIntentsForReplay(records, isSatisfied) {
  const byId = new Map(records.map((r) => [r.intent.id, r]));

  const ordered = [];
  const visited = new Set();
  const visiting = [];

  function visit(id, requiredBy) {
    if (visited.has(id)) return;

    const cycleStart = visiting.indexOf(id);
    if (cycleStart !== -1) {
      const cycle = [...visiting.slice(cycleStart), id].join(' -> ');
      throw new Error(
        `intent depends_on cycle detected: ${cycle}. ` +
          `Fix the depends_on lists in ${INTENTS_DIR} — no replay order can satisfy a cycle.`,
      );
    }

    const entry = byId.get(id);
    if (!entry) {
      // Not a file in this directory. Fine if the DB already has it
      // (rebuild tolerates an already-populated DB); otherwise the edge
      // points at nothing and would fail the FOREIGN KEY.
      if (isSatisfied(id)) return;
      throw new Error(
        `intent "${requiredBy}" depends_on "${id}", which has no intent file in ` +
          `${INTENTS_DIR} and no row in the build graph. ` +
          `Restore ${id}.json or remove it from "${requiredBy}"'s depends_on.`,
      );
    }

    visiting.push(id);
    for (const depId of entry.intent.depends_on) visit(depId, id);
    visiting.pop();

    visited.add(id);
    ordered.push(entry);
  }

  for (const record of records) visit(record.intent.id, null);

  return ordered;
}

// Reads every intent file, normalizes it, orders the set by depends_on,
// and inserts the rows. Read-only with respect to the files themselves.
//
// The insert is unconditional (an intent id is never re-added through
// `intent add` in normal use), so rebuild — the one caller that must also
// tolerate an already-populated DB, per "re-derive from source-of-truth
// after suspected corruption" — skips any intent whose id is already
// present rather than letting the UNIQUE constraint fail the whole run.
//
// Ordering is resolved for the whole set BEFORE any row is written, so a
// cycle or a dangling depends_on fails the run without having half-built
// the graph.
async function replayIntents(db, intentsDir) {
  const files = await loadIntentFiles(intentsDir);

  const records = [];
  for (const file of files) {
    const path = `${intentsDir}/${file}`;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      throw new Error(`could not read intent file ${path}: ${err.message}`);
    }
    try {
      records.push({ file, intent: normalizeIntent(parsed) });
    } catch (err) {
      throw new Error(`invalid intent file ${path}: ${err.message}`);
    }
  }

  const ordered = orderIntentsForReplay(records, (id) => intentExists(db, id));

  let count = 0;
  for (const { intent } of ordered) {
    if (intentExists(db, intent.id)) continue;
    insertIntentRows(db, intent);
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
// replayed in dependency order, then planTasks to re-derive tasks +
// dependencies, then git history to reconcile which tasks already
// completed. Returns a summary for the CLI to print.
//
// `drift` in the return is the honest disclosure this rebuild owes its
// caller. A rebuild re-derives every task's layer-derived fields from
// the *current* core.yaml (composed with `.hedgehog/overrides/*.json`,
// which — unlike a hand-edited task row — IS a committed source and so
// DOES survive), so any hand-edit made directly to a task row that never
// got written as an override file has no committed source to replay from
// and does not survive. Rows that predate this rebuild are left as they
// are, which is the other half of the same problem: they can be stale
// against core.yaml and nothing would otherwise say so. Reporting the
// divergence is what turns both into something the operator sees instead
// of something they discover three layers later.
export async function rebuildDb(
  db,
  { corePath, intentsDir = INTENTS_DIR, overridesDir = OVERRIDES_DIR } = {},
) {
  applySchema(db);

  const intentsReplayed = await replayIntents(db, intentsDir);

  const core = await loadCore(corePath);
  const overrides = await loadOverrides(overridesDir);
  planTasks(db, core, overrides);

  const commitSubjects = loadCommitSubjects();
  const tasksMarkedComplete = markCompletedTasks(db, commitSubjects);

  const drift = detectDrift(db, core, { overrides });

  return { intentsReplayed, tasksMarkedComplete, drift };
}
