// `hedgehog db rebuild` — reconstructs the build graph from committed
// source-of-truth files, for a fresh clone (no `.hedgehog/hedgehog.db`),
// a `git worktree` that just merged back into trunk, or after suspected
// corruption. The DB itself is a derived artifact: everything it holds is
// either replayable from `.hedgehog/intents/*.json` (via the same
// normalize/insert path `intent add`/`plan` already use), recoverable
// from git history (which tasks' commits already landed), replayable
// from `.hedgehog/reconciled/*.json` (which tasks a user confirmed as
// done by work git history cannot credit — reconcile.mjs), or replayable
// from `.hedgehog/abandoned/*.json` (which intents were deliberately
// dropped rather than finished — worktree.mjs). What isn't recoverable —
// `verifications.output`, the ephemeral diagnostics of a run that already
// passed — is an accepted loss; this only reconciles `tasks.status`.
//
// This is also `hedgehog merge`'s entire "merge the graph" step: a
// worktree's own `.hedgehog/hedgehog.db` never crosses into trunk's — git
// merges the committed sources (the intent file, the source code, any
// notes/reconciliation/abandonment records), and this function re-derives
// trunk's graph from what merged, exactly as it would for a fresh clone.
// No DB row is ever copied between databases.
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
import { planTasks, CORE_MODULE, CORE_INTENT_ID } from './plan.mjs';
import { loadCore } from './core.mjs';
import { detectDrift } from './drift.mjs';
import { loadOverrides, OVERRIDES_DIR } from './overrides.mjs';
import {
  loadReconciliations,
  orphanedReconciliations,
  reconciledNote,
  RECONCILED_DIR,
} from './reconcile.mjs';
import { loadNotes, NOTES_DIR } from './notes.mjs';
import {
  loadAbandoned,
  replayAbandonments,
  ABANDONED_DIR,
  hedgehogWorktrees,
  onHedgehogBranch,
} from './worktree.mjs';

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

// A rebuild's result is a pure function of the committed sources
// (`.hedgehog/intents/`, core.yaml, overrides, git history), so the
// derived graph is cleared before replay rather than replayed on top of
// whatever the DB already held. Without this, an intent file that was
// renamed or deleted leaves its tasks behind: the scheduler then sees a
// ghost task whose scope overlaps the real one and holds the real one
// back, producing a graph no set of committed intents describes.
//
// Deleting `intents` cascades through requirements, tasks,
// task_requirements, dependencies, artifacts, verifications, `debt` and
// `decisions` (all `ON DELETE CASCADE` from `tasks`) — every one of which
// this run re-derives. `debt` and `decisions` are then replayed from
// `.hedgehog/notes/*.json` (replayNotes, below) rather than carried
// across from the DB's own prior rows — a worktree's own DB never held a
// sibling worktree's notes, so carrying across only the current DB's rows
// would silently drop everything logged elsewhere. `friction` keeps its
// own committed source (`.hedgehog/friction/log.md`, friction.mjs) and is
// left untouched here — its `task_id` is `ON DELETE SET NULL`, not
// CASCADE, so its rows outlive this delete unattached rather than being
// cleared.
//
// One class of decision row needs no replay from notes.mjs: the
// provenance note a reconciliation writes (reconcile.mjs). That one has a
// different committed source — `.hedgehog/reconciled/*.json` — and
// replayReconciliations below re-writes it from that file instead.
function clearDerivedGraph(db) {
  db.prepare('DELETE FROM intents').run();
}

// Replays `.hedgehog/notes/*.json` (notes.mjs) — the committed record
// behind every `debt add` / `decision add` call — the same way
// replayReconciliations below replays `.hedgehog/reconciled/*.json`. A
// note whose task no longer exists in the new graph has nowhere to live
// and is reported rather than silently dropped.
function replayNotes(db, notesByTask) {
  const taskExists = db.prepare('SELECT 1 FROM tasks WHERE id = ?');
  const insertDebt = db.prepare(
    'INSERT INTO debt (task_id, note, logged_at) VALUES (?, ?, ?)',
  );
  const insertDecision = db.prepare(
    'INSERT INTO decisions (task_id, note, logged_at) VALUES (?, ?, ?)',
  );

  const orphaned = [];
  for (const [taskId, notes] of notesByTask) {
    if (taskExists.get(taskId) === undefined) {
      for (const entry of notes) {
        orphaned.push({ kind: entry.kind, taskId, note: entry.note });
      }
      continue;
    }
    for (const entry of notes) {
      if (entry.kind === 'debt') {
        insertDebt.run(taskId, entry.note, entry.logged_at);
      } else {
        insertDecision.run(taskId, entry.note, entry.logged_at);
      }
    }
  }
  return orphaned;
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
      // Not a file in this directory, and the derived graph was cleared
      // before replay, so the edge points at nothing and would fail the
      // FOREIGN KEY.
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
      throw new Error(`could not read intent file ${path}: ${err.message}`, { cause: err });
    }
    try {
      records.push({ file, intent: normalizeIntent(parsed) });
    } catch (err) {
      throw new Error(`invalid intent file ${path}: ${err.message}`, { cause: err });
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

// Every commit subject in history mapped to EVERY position it occurs at,
// newest first — one `git log` call rather than one per task. Membership
// alone answers "did this task ever run"; position also answers "did it
// run *after* the thing it depends on", which is what a `once: true`
// task needs, since its commit subject is a constant that one historical
// occurrence would otherwise satisfy forever. Keeping every occurrence
// (not just the newest) is what lets markCompletedTasks tell two tasks
// that share a constant commit_message apart on a linear-chain core: one
// real commit per intent that actually ran the layer, each position
// claimable by at most one task. `--topo-order` so position is a
// property of the history's shape rather than of commit timestamps.
function loadCommitSubjects() {
  const output = execSync('git log --topo-order --format=%H%x00%s', { encoding: 'utf8' });
  const positions = new Map();
  let position = 0;
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [, subject] = line.split('\0');
    if (subject === undefined) continue;
    // Newest first, so pushing in read order keeps each subject's array
    // newest-to-oldest.
    if (!positions.has(subject)) positions.set(subject, []);
    positions.get(subject).push(position);
    position++;
  }
  return positions;
}

// A task is complete iff some commit's subject exactly matches its
// commit_message — the same message verifyTask used when it made that
// commit. Marks status directly rather than through verifyTask's flow:
// there's no verify_command to re-run and no working tree diff to check,
// only the historical fact that the commit already happened.
//
// A task's `commit_message` is unique to it exactly when the layer's
// `commit` template interpolates `{module}` — the module-axis case,
// where each intent's copy of the layer produces a distinct string. A
// `once: true` layer has no module to substitute (core.mjs's
// validateCore rejects one that names {module}), so its single task's
// commit subject is a constant by construction — and, since a core
// compiles at most one once-task per once-layer, that task is the only
// one carrying its subject. A linear-chain core (authored, adopted) has
// no module axis at all: every layer's `commit` is a fixed string in
// core.yaml with no `{module}` token, so every intent that walks the
// chain compiles a per-layer task carrying that same constant — one task
// per intent, all sharing one subject.
//
// A commit_message shared by more than one task (grouped below into
// `ambiguousTasks`) means membership in commitSubjects can't tell those
// tasks apart: every commit ever made with that subject is a candidate
// match for every one of them. Two conditions resolve it:
//
//   1. Ordering — a task's own matching commit must sit *above* (be
//      newer than) every one of its own prerequisites' matching
//      commits, the same way a once-task has always required its commit
//      to postdate the module it deploys. Without this, the first
//      intent's commit for a layer would satisfy every later intent's
//      task of that same layer forever, re-closing the layer on a fresh
//      clone regardless of what that later intent's own chain has
//      actually done.
//   2. Consumption — a group of N tasks sharing a subject can credit at
//      most as many of them complete as there are actual commits with
//      that subject in history, each commit backing at most one task.
//      Ordering alone doesn't catch a head-of-chain task: with no
//      prerequisite of its own, "ran after its prerequisites" is
//      vacuously true regardless of which commit it points at, which is
//      exactly the shape of the bug — a fresh intent's first layer,
//      sharing a constant commit_message with an already-built intent's
//      completed first layer, has nothing to check position against.
//      Consumption is what a head-of-chain task actually needs: once
//      every real commit for that subject is claimed by other tasks,
//      none is left for it to point at.
//
// Both are walked together, per group, in a single deterministic pass
// ordered by task id: earlier-sorted tasks get first claim on the
// oldest still-unclaimed matching commit that satisfies the ordering
// condition against whatever their own prerequisites already claimed.
// A task that finds no claimable commit is left incomplete — the safe
// direction, matching every other cross-cutting-layer default in this
// engine (re-running an idempotent step beats silently skipping one).
// The whole thing is walked to a fixpoint, since one ambiguous task's
// claim can be the prerequisite another ambiguous task needs before it
// can claim its own (a once-layer behind another once-layer, or one
// linear-chain layer behind the one before it in the same intent).
//
// A task with a commit_message unique to it (the ordinary module-axis
// case) skips all of this: it is marked complete directly from
// commitSubjects membership, with no ordering or consumption check.
// That's necessary, not just cheaper — a task that completed without
// touching any file leaves no commit at all (verifyTask writes none),
// and applying either check there would cascade that gap through the
// whole chain and reset already-built modules that have no ambiguity to
// resolve in the first place.
function markCompletedTasks(db, commitSubjects) {
  const tasks = db.prepare('SELECT id, module, commit_message FROM tasks').all();
  const prerequisites = new Map(tasks.map((t) => [t.id, []]));
  for (const d of db.prepare('SELECT task_id, depends_on_task_id FROM dependencies').all()) {
    prerequisites.get(d.task_id)?.push(d.depends_on_task_id);
  }

  const messageCounts = new Map();
  for (const task of tasks) {
    messageCounts.set(task.commit_message, (messageCounts.get(task.commit_message) ?? 0) + 1);
  }
  const isAmbiguous = (task) => messageCounts.get(task.commit_message) > 1;

  // Position of each unambiguous task's one matching commit; undefined
  // means the task never committed. An ambiguous task's position is
  // resolved separately below, since "the" matching commit for its
  // subject isn't decided until a claim succeeds.
  const positionOf = new Map();
  const complete = new Set();
  const ambiguousTasks = [];
  for (const task of tasks) {
    if (task.module === CORE_MODULE || isAmbiguous(task)) {
      ambiguousTasks.push(task);
      continue;
    }
    const position = (commitSubjects.get(task.commit_message) ?? [])[0];
    positionOf.set(task.id, position);
    if (position !== undefined) complete.add(task.id);
  }
  // Deterministic claim order within a shared subject: sorted by task id.
  ambiguousTasks.sort((a, b) => a.id.localeCompare(b.id));

  // Every commit position still unclaimed, per subject — shrinks as
  // ambiguous tasks below claim one each.
  const available = new Map(
    [...commitSubjects].map(([subject, positions]) => [subject, [...positions]]),
  );

  // A task ran after a prerequisite when its own claimed position is
  // strictly smaller (newer) than the prerequisite's.
  const ranAfterPrerequisites = (task, position) =>
    prerequisites.get(task.id).every((id) => {
      const prereq = positionOf.get(id);
      return prereq === undefined || position < prereq;
    });

  let changed = true;
  while (changed) {
    changed = false;
    for (const task of ambiguousTasks) {
      if (complete.has(task.id) || positionOf.has(task.id)) continue;
      if (!prerequisites.get(task.id).every((id) => complete.has(id))) continue;

      const slots = available.get(task.commit_message) ?? [];
      // Oldest-first, so a task claims the least-recent commit that
      // still satisfies its ordering condition — leaving newer slots
      // free for whichever task in the group depends on this one.
      const slotIndex = [...slots]
        .map((position, i) => [position, i])
        .sort((a, b) => b[0] - a[0])
        .find(([position]) => ranAfterPrerequisites(task, position))?.[1];
      if (slotIndex === undefined) continue;

      const [position] = slots.splice(slotIndex, 1);
      positionOf.set(task.id, position);
      complete.add(task.id);
      changed = true;
    }
  }

  const setComplete = db.prepare("UPDATE tasks SET status = 'complete' WHERE id = ?");
  for (const id of complete) setComplete.run(id);

  // A task on the ambiguous path can be marked complete by the loop
  // above and then fail to claim a slot on a later pass of the fixpoint
  // walk. Reconcile it back rather than leaving the stale status
  // untouched.
  const reopen = db.prepare(
    "UPDATE tasks SET status = 'planned' WHERE id = ? AND status = 'complete'",
  );
  for (const task of ambiguousTasks) {
    if (!complete.has(task.id)) reopen.run(task.id);
  }

  return complete.size;
}

// Closes every intent whose tasks are all `complete` — the same rule
// verify.mjs#completeIntentIfDone applies live, one task at a time, as
// each one verifies. A rebuild has to re-derive the same fact in bulk: a
// task's own completion is recovered above (from git history) or below
// (from a reconciliation record), but neither path touches `intents.status`
// — that row was set live, by the `verify`/`reconcile confirm` call that
// happened to close the intent's last task, and a rebuild that never ran
// through either path has no equivalent write. Left undone, an intent
// whose tasks all read `complete` after a rebuild would still read
// `active` — which is silently wrong on its own (`hedgehog status`'s
// intent-facing views would call finished work still in progress) and,
// for worktree.mjs#eligibleIntents specifically, load-bearing: a
// dependent intent's `intent_dependencies` gate reads `intents.status`,
// not task status, so a rebuild that skipped this step would leave an
// otherwise-finished intent permanently ineligible for the worktree
// trigger. The synthesised core intent (plan.mjs's CORE_INTENT_ID) is
// deliberately excluded — its own completion is a different rule
// (planTasks/reopenOnceTasks manage it directly, tied to once-layer
// re-entrancy) that this generic sweep would get wrong.
function markCompletedIntents(db) {
  const rows = db
    .prepare(
      `UPDATE intents SET status = 'complete'
       WHERE status <> 'complete' AND id <> ?
         AND id IN (SELECT intent_id FROM tasks)
         AND NOT EXISTS (
           SELECT 1 FROM tasks WHERE tasks.intent_id = intents.id AND tasks.status <> 'complete'
         )
       RETURNING id`,
    )
    .all(CORE_INTENT_ID);
  return rows.map((r) => r.id);
}

// Replays `.hedgehog/reconciled/*.json` — the committed record of every
// task a user confirmed as already done by work that landed outside the
// loop (reconcile.mjs).
//
// This runs after markCompletedTasks and does the same job by a different
// route. markCompletedTasks credits a task only when some commit subject
// matches its `commit_message` exactly, which is the subject `verify`
// itself writes — a hand-written commit never matches, by construction,
// which is the whole reason reconcile exists. So a reconciled task needs
// no commit-message match here: the committed confirmation IS the source,
// exactly as an override file is the source for a widened scope.
//
// Without this step a rebuild silently reverts every confirmed
// reconciliation and reintroduces the problem reconcile was run to fix,
// which is worse than never reconciling — it looks like it worked.
//
// The provenance note is re-written here too, so a reconciled task's
// "closed without a verify run" fact reaches its dependents' packets on a
// fresh clone the same as it did on the machine that confirmed it.
function replayReconciliations(db, reconciliations) {
  const setComplete = db.prepare(
    "UPDATE tasks SET status = 'complete', blocked_reason = NULL WHERE id = ?",
  );
  const insertNote = db.prepare('INSERT INTO decisions (task_id, note) VALUES (?, ?)');
  const taskExists = db.prepare('SELECT 1 FROM tasks WHERE id = ?');

  let replayed = 0;
  for (const [taskId, record] of reconciliations) {
    if (taskExists.get(taskId) === undefined) continue;
    setComplete.run(taskId);
    insertNote.run(taskId, reconciledNote(record));
    replayed++;
  }
  return replayed;
}

// Rebuilds `db` from scratch: schema, then every committed intent
// replayed in dependency order, then planTasks to re-derive tasks +
// dependencies, then git history to reconcile which tasks already
// completed, then `.hedgehog/reconciled/*.json` for the tasks a user
// confirmed as done by work that git history cannot credit. Returns a
// summary for the CLI to print.
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
  {
    corePath,
    intentsDir = INTENTS_DIR,
    overridesDir = OVERRIDES_DIR,
    reconciledDir = RECONCILED_DIR,
    notesDir = NOTES_DIR,
    abandonedDir = ABANDONED_DIR,
    // `hedgehog merge <id>`'s own rebuild call (bin/cli.mjs#mergeCommand):
    // at the point it calls rebuildDb, `git merge --no-ff` has already
    // landed the merged intent's sources onto trunk, but its worktree
    // hasn't been removed yet (removal happens after, deliberately — see
    // mergeCommand — so a failed removal doesn't leave trunk un-rebuilt).
    // `hedgehogWorktrees()` therefore still reports it as open, and
    // without this override the exclusion logic below would exclude the
    // very intent this rebuild exists to bring onto trunk. Named, not
    // just "don't exclude anything", so the caller states which intent it
    // just merged rather than this function guessing.
    mergingIntentId = null,
  } = {},
) {
  applySchema(db);

  clearDerivedGraph(db);

  const intentsReplayed = await replayIntents(db, intentsDir);

  const core = await loadCore(corePath);
  const overrides = await loadOverrides(overridesDir);
  const reconciliations = await loadReconciliations(reconciledDir);
  const notesByTask = await loadNotes(notesDir);
  const abandonments = await loadAbandoned(abandonedDir);

  // Mirrors bin/cli.mjs#planCommand's own exclusion set: an intent still
  // holding an open, unmerged, unabandoned `hedgehog/*` worktree has its
  // tasks compiled only inside that worktree's own graph (worktree.mjs's
  // file header), never on trunk. `hedgehog merge`/`hedgehog abandon` both
  // remove the worktree as part of closing it out, so hedgehogWorktrees()
  // — read against `process.cwd()` — reports exactly the still-open set.
  // Without this, a rebuild run directly on trunk while a worktree is
  // open (rather than through `hedgehog merge`, which never reaches this
  // far while a *different* intent's worktree is still open) would
  // recompile that intent's tasks onto trunk too, producing two divergent
  // copies of the same intent with no reconciliation path.
  //
  // Skipped entirely when this rebuild is itself running inside a
  // `hedgehog/*` worktree (onHedgehogBranch — the same guard
  // bin/cli.mjs#planCommand uses to stop its own recursive trigger).
  // `git worktree list --porcelain` reports every worktree of the repo
  // from any of their checkouts, including the one you're standing in —
  // so without this guard, a worktree's own `hedgehog db rebuild` (or the
  // recursive `hedgehog plan` that runs one right after `git worktree
  // add`) would see itself in hedgehogWorktrees() and exclude its own
  // intent from its own compile, the exact self-exclusion this function
  // exists to prevent everywhere else.
  const openWorktreeIntentIds = onHedgehogBranch()
    ? new Set()
    : new Set(
        hedgehogWorktrees()
          .map((w) => w.intentId)
          .filter((intentId) => intentId !== mergingIntentId),
      );
  planTasks(db, core, overrides, { excludeIntentIds: openWorktreeIntentIds });

  const commitSubjects = loadCommitSubjects();
  const tasksMarkedComplete = markCompletedTasks(db, commitSubjects);

  const tasksReconciled = replayReconciliations(db, reconciliations);
  const orphanedReconciled = orphanedReconciliations(db, reconciliations);

  // After every task-status recovery path above (history-matched commits,
  // then reconciliation) — either can close an intent's last open task,
  // and this is the single place that re-derives `intents.status` from
  // whatever task statuses just settled, in bulk, the same fact
  // verify.mjs#completeIntentIfDone writes live one task at a time.
  const intentsMarkedComplete = markCompletedIntents(db);

  const orphanedNotes = replayNotes(db, notesByTask);

  // After planTasks and markCompletedTasks, not before: an abandoned
  // intent's `.hedgehog/intents/<id>.json` is still on disk (abandonment
  // never deletes it — only merge and a fresh `intent add` touch that
  // file), so planTasks recompiles its tasks fresh, all `planned`, and
  // flips the intent to `active`. This replay is what corrects the
  // intent's own status back to `planned` and, on the rarer path where
  // some of its tasks previously reached trunk before being reset (a
  // second abandon after a partial reconcile, for instance), resets them
  // too — see worktree.mjs#replayAbandonments.
  const { replayed: abandonmentsReplayed, orphaned: orphanedAbandonments } = replayAbandonments(
    db,
    abandonments,
  );

  const drift = detectDrift(db, core, { overrides });

  return {
    intentsReplayed,
    tasksMarkedComplete,
    intentsMarkedComplete,
    tasksReconciled,
    orphanedReconciled,
    orphanedNotes,
    abandonmentsReplayed,
    orphanedAbandonments,
    drift,
  };
}
