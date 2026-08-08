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
import { planTasks } from './plan.mjs';
import { loadCore } from './core.mjs';

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
// replayed in dependency order, then planTasks to re-derive tasks +
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
