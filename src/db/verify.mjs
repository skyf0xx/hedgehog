// `hedgehog verify <task-id>` — lease check, scope pre-check, then
// verify_command, then state transition. See
// hedgehog-persistent-build-graph.md, "Task lifecycle", "`hedgehog
// verify`", and "Scope enforcement is a hard pre-verification check".
//
// Phase 0: load the task, reap its lease if `lease_expires_at` has
// passed (same reaping claimTasks does lazily — otherwise a build that
// outlived its lease with no concurrent `claim` call in the interim
// would still look legitimately leased here), assert it's `building` and
// leased to `owner`, then set `verifying` — a small transaction, before
// either gate below.
//
// Two gates, in order:
//   1. `git diff --name-only` (working tree) against the task's
//      scope_globs, with paths inside any other in-flight task's own
//      declared scope excluded first — those are a concurrent neighbor's
//      legitimate uncommitted edits, not this task's violation, since
//      there's no working-tree isolation between concurrent tasks by
//      design. Any remaining touched path outside scope refuses to run
//      verification at all — the task moves to `blocked` with
//      blocked_reason `scope_violation`, no `verifications` row written,
//      lease released. This is a scope violation, not a failing check.
//   2. Only once every touched path matches scope does verify_command run.
//      Exit 0: verifications row (passed) → artifacts recorded → git
//      commit with commit_message → complete, lease released → direct
//      dependents re-evaluated (a dependent is ready once every
//      dependency is complete — same check as the readiness SELECT in
//      next.mjs).
//      Nonzero: verifications row (failed, output retained) → blocked
//      with blocked_reason `verification_failed`, lease released,
//      dependents stay blocked.
//
// The commit lock (commitLock.mjs, backed by the gitignored `.hedgehog/
// commit.lock`) wraps gate 1's diff read and, separately, gate 2's
// artifact-classify-and-commit — git has one working tree and one index
// shared by every concurrent `hedgehog verify` process, so two tasks'
// commit phases interleaving would let one task's `git commit` (no
// pathspec) sweep up the other's staged-but-uncommitted files under the
// wrong commit message, and would let one task's scope diff and its own
// neighbor-exclusion diff (two separate git calls) see a working tree
// that changed between them. verify_command itself runs outside the lock
// — it's the slow part, and holding a lock across it would serialize
// verification itself rather than just the git-mutating instants around
// it.
//
// No subprocess (git, verify_command) ever runs while a sqlite
// transaction is open: every execSync call in this file happens before
// BEGIN or after COMMIT, never between them.

import { execSync } from 'node:child_process';
import { DB_PATH } from './init.mjs';
import { withCommitLock, LOCK_PATH } from './commitLock.mjs';
import { reapExpiredLeases } from './claim.mjs';

// The build graph file and the commit lock are engine state, written
// only by this CLI, never by an agent — both are excluded from every
// task's scope check (and from artifacts/commits), or verify's own
// writes ahead of and during the verify_command run would trip the very
// check they're performing. Covers SQLite's journal/WAL/SHM sidecar
// files too.
function isEngineStatePath(path) {
  return path === DB_PATH || path.startsWith(`${DB_PATH}-`) || path === LOCK_PATH;
}

// Shell-safe quoting for paths interpolated into a git command line,
// matching the JSON.stringify(path) convention used elsewhere in this
// file for the same purpose.
function quotePathspec(path) {
  return JSON.stringify(path);
}

// Working-tree diff (relative paths), optionally restricted to `pathspecs`
// via git's own pathspec matching (e.g. `:(glob)packages/db/src/schema/**`)
// — covers modified, added, deleted, and untracked files, everything the
// agent could have touched.
function changedPaths(pathspecs) {
  const scopeArgs = pathspecs ? ` -- ${pathspecs.map(quotePathspec).join(' ')}` : '';
  const tracked = execSync(`git diff --name-only HEAD${scopeArgs}`, { encoding: 'utf8' });
  const untracked = execSync(
    `git ls-files --others --exclude-standard${scopeArgs}`,
    { encoding: 'utf8' },
  );
  const paths = new Set(
    [...tracked.split('\n'), ...untracked.split('\n')].map((p) => p.trim()).filter(Boolean),
  );
  return [...paths].filter((p) => !isEngineStatePath(p));
}

// Every other task currently `building` or `verifying` — their declared
// scope_globs are files a concurrent neighbor legitimately owns mid-edit,
// not this task's violation. There is no working-tree isolation between
// concurrent tasks (by design — see the plan's "one working tree with
// disjoint scopes"), so the repo-wide diff below sees every in-flight
// task's uncommitted edits at once; this is what lets the gate tell them
// apart. Whether a neighbor shares this task's owner doesn't matter: the
// scheduler's conflict predicate (conflict.mjs) already guarantees any
// task the same owner holds concurrently has a disjoint scope from this
// one, the same as a different owner's task would.
function loadOtherInFlightScopes(db, taskId) {
  const rows = db
    .prepare(`SELECT scope_globs FROM tasks WHERE id <> ? AND status IN ('building', 'verifying')`)
    .all(taskId);
  return rows.flatMap((row) => JSON.parse(row.scope_globs));
}

// Splits the working tree's touched paths into `inScope` (this task's own
// scope_globs — the only set that gets classified, recorded as artifacts,
// and committed) and `offending` (touched outside scope AND outside every
// other in-flight task's own declared scope — a real violation, not a
// concurrent neighbor's legitimate uncommitted work). `touched` (the
// full, unrestricted diff) is used only to compute `offending`; it is
// never itself the commit set, or a neighbor's uncommitted file sitting
// in the shared working tree would ride along into this task's commit.
function splitByScope(db, taskId, touched, scopeGlobs) {
  const pathspecs = scopeGlobs.map((glob) => `:(glob)${glob}`);
  const inScope = changedPaths(pathspecs);
  const inScopeSet = new Set(inScope);

  const neighborGlobs = loadOtherInFlightScopes(db, taskId);
  const neighborPathspecs = neighborGlobs.map((glob) => `:(glob)${glob}`);
  const neighborOwned = new Set(
    neighborPathspecs.length > 0 ? changedPaths(neighborPathspecs) : [],
  );

  const offending = touched.filter((path) => !inScopeSet.has(path) && !neighborOwned.has(path));
  return { inScope, offending };
}

function loadTask(db, taskId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
}

// Sets `status`, and whenever that status leaves building/verifying
// (complete or blocked) clears the lease fields — a task that isn't
// building or verifying holds no lease, per the schema's CHECK. Pass
// `blockedReason` when status is `blocked`.
function setTaskStatus(db, taskId, status, { blockedReason } = {}) {
  const releasesLease = status === 'complete' || status === 'blocked';
  db.prepare(
    `
    UPDATE tasks SET
      status = ?,
      blocked_reason = ?,
      lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
      lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END,
      leased_at = CASE WHEN ? THEN NULL ELSE leased_at END
    WHERE id = ?
  `,
  ).run(status, blockedReason ?? null, releasesLease ? 1 : 0, releasesLease ? 1 : 0, releasesLease ? 1 : 0, taskId);
}

const insertVerification = (db) =>
  db.prepare(`
    INSERT INTO verifications (task_id, command, exit_code, output, status)
    VALUES (?, ?, ?, ?, ?)
  `);

const insertArtifact = (db) =>
  db.prepare(`
    INSERT INTO artifacts (task_id, path, kind, commit_sha)
    VALUES (?, ?, ?, ?)
  `);

// Direct dependents of `taskId` — same shape as next.mjs's
// loadDirectDependents, kept local since verify.mjs owns the write side
// and next.mjs owns the read side of the same query.
function loadDirectDependents(db, taskId) {
  return db
    .prepare(
      `
      SELECT t.* FROM tasks t
      JOIN dependencies d ON d.task_id = t.id
      WHERE d.depends_on_task_id = ?
      ORDER BY t.priority, t.id
    `,
    )
    .all(taskId);
}

// True when every dependency of `taskId` is `complete` — the same
// condition the readiness SELECT in next.mjs checks, reused here so a
// dependent is only ever unlocked by the one rule the engine has for
// readiness.
function hasNoIncompleteDependency(db, taskId) {
  const blocker = db
    .prepare(
      `
      SELECT 1 FROM dependencies d
      JOIN tasks dep ON dep.id = d.depends_on_task_id
      WHERE d.task_id = ? AND dep.status <> 'complete'
    `,
    )
    .get(taskId);
  return blocker === undefined;
}

// Marks `taskId`'s direct dependents `ready` wherever every one of their
// dependencies (not just this one) is now `complete` — but only if the
// dependent is still `planned`. A dependent already `blocked` is stalled,
// not blocked-on-deps, and must not be silently cleared back to `ready`
// just because its deps happened to complete.
function unlockReadyDependents(db, taskId) {
  const unlocked = [];
  for (const dependent of loadDirectDependents(db, taskId)) {
    if (dependent.status !== 'planned') continue;
    if (hasNoIncompleteDependency(db, dependent.id)) {
      setTaskStatus(db, dependent.id, 'ready');
      unlocked.push(dependent.id);
    }
  }
  return unlocked;
}

// Marks `intentId` complete once every task compiled from it is
// `complete`. Completion is terminal bookkeeping, not a cleanup trigger
// (spec: "Traceability") — the intent's tasks, verifications, and
// artifacts stay exactly where they are as the provenance trail; the
// status change only stops `hedgehog plan` from treating it as pending
// and lets `status`/`next` report the intent honestly.
function completeIntentIfDone(db, intentId) {
  const openTask = db
    .prepare(
      "SELECT 1 FROM tasks WHERE intent_id = ? AND status <> 'complete'",
    )
    .get(intentId);
  if (openTask !== undefined) return false;
  db.prepare("UPDATE intents SET status = 'complete' WHERE id = ?").run(intentId);
  return true;
}

// Runs `command` via the shell, capturing combined stdout+stderr and exit
// code without throwing on nonzero exit — a failing verify_command is an
// expected outcome, not a Node exception.
function runVerifyCommand(command) {
  try {
    const output = execSync(command, { encoding: 'utf8', stdio: 'pipe' });
    return { exitCode: 0, output };
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message;
    return { exitCode: err.status ?? 1, output };
  }
}

// Classifies each of `paths` as 'created' or 'modified' against HEAD with
// a single `git ls-tree` call rather than one `git cat-file` subprocess
// per path: anything ls-tree reports already existed in HEAD.
function classifyArtifacts(paths) {
  if (paths.length === 0) return new Map();
  const quoted = paths.map(quotePathspec).join(' ');
  const output = execSync(`git ls-tree -r --name-only HEAD -- ${quoted}`, {
    encoding: 'utf8',
  });
  const existing = new Set(output.split('\n').map((p) => p.trim()).filter(Boolean));
  return new Map(paths.map((path) => [path, existing.has(path) ? 'modified' : 'created']));
}

// Determines created vs modified against HEAD, then stages and commits
// exactly the task's touched paths with commit_message. Returns the new
// commit sha.
//
// The build graph (`.hedgehog/hedgehog.db`) is gitignored and derived —
// isEngineStatePath excludes it from `touched`, so it's never staged or
// committed here. What survives `/clear`, machine moves, and reclone is
// the committed intents/friction/core.yaml plus the commit history
// itself; `hedgehog db rebuild` replays those into a fresh DB. The commit
// this function makes is the task's final commit; nothing amends it
// afterward.
function commitTouchedPaths(paths, commitMessage) {
  const quoted = paths.map(quotePathspec).join(' ');
  execSync(`git add -- ${quoted}`, { stdio: 'pipe' });
  execSync(`git commit -m ${JSON.stringify(commitMessage)}`, { stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
}

// Second paragraph of the no-op layer's commit, so the empty commit reads
// as a deliberate record rather than a stray `--allow-empty`. Deliberately
// free of backticks: this string is interpolated into a shell command
// below, where a backtick would be command substitution, not punctuation.
const NO_OP_COMMIT_NOTE =
  'Verified no-op: this layer had nothing left to change. Recorded as an ' +
  'empty commit so one layer still means one commit, and so the completion ' +
  'survives a "hedgehog db rebuild", which replays git history.';

// The same commit as commitTouchedPaths, for a layer whose verification
// passed with nothing in scope touched — a legitimate outcome when the
// layer's work was already satisfied upstream. Returns the new commit sha.
//
// Skipping the commit here would close the task `complete` with HEAD
// unchanged, and that completion is then unreconstructible: the build
// graph is gitignored and derived (see commitTouchedPaths above), so
// `hedgehog db rebuild` — which replays the committed sources against git
// history — has nothing to replay and reports the layer as never built.
// `--allow-empty` is what makes the record exist at all; git refuses an
// empty commit otherwise.
function commitNoOpLayer(commitMessage) {
  execSync(
    `git commit --allow-empty -m ${JSON.stringify(commitMessage)} -m ${JSON.stringify(
      NO_OP_COMMIT_NOTE,
    )}`,
    { stdio: 'pipe' },
  );
  return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
}

// Phase 0: reap expired leases, load `taskId`, assert it's `building` and
// leased to `owner`, then set `verifying` — one small transaction. Throws
// rather than proceeding when the lease doesn't match (including a lease
// that was just reaped for expiring), so a stale or racing caller can't
// run verification against a task it doesn't hold.
function claimForVerify(db, taskId, owner) {
  let task;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Reaps this (and any other) task's lease if lease_expires_at has
    // passed, before the ownership check below reads status/lease_owner
    // — otherwise a build that outlived its lease with no concurrent
    // `claim` call in the interim reaches the check below still looking
    // legitimately leased, and verify would honor a lease that's already
    // expired.
    reapExpiredLeases(db);
    task = loadTask(db, taskId);
    if (!task) throw new Error(`no such task: ${taskId}`);
    if (task.status !== 'building' || task.lease_owner !== owner) {
      throw new Error(
        `Task ${taskId} is not leased to ${owner} (currently: ${task.status}${
          task.lease_owner ? ', leased to ' + task.lease_owner : ''
        })`,
      );
    }
    setTaskStatus(db, task.id, 'verifying');
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback failing must not mask the original error.
    }
    throw err;
  }
  return { ...task, status: 'verifying' };
}

// Runs the full verify flow for `taskId`, held by `owner`'s lease.
// Returns a result object describing what happened:
//   { outcome: 'scope_violation', offending: [...] }
//   { outcome: 'failed', exitCode, output }
//   { outcome: 'complete', exitCode, output, commitSha, unlocked: [...] }
export function verifyTask(db, taskId, owner) {
  const task = claimForVerify(db, taskId, owner);

  const scopeGlobs = JSON.parse(task.scope_globs);
  // Gate 1 runs inside the commit lock: the diff has to see a working
  // tree no other task's commit is landing into mid-read, and the
  // neighbor-scope split has to be computed against a snapshot, not a
  // set that another verify's commit could shrink out from under it
  // between the several changedPaths() calls inside it. Only `offending`
  // is used here — `inScope` is discarded and recomputed fresh just
  // before the commit below, since verify_command (which runs, unlocked,
  // in between) can itself touch files inside this task's own scope
  // (generated lockfiles, formatted output), and committing a stale
  // pre-verify_command snapshot would silently drop those.
  const { offending } = withCommitLock(() => {
    const touchedNow = changedPaths();
    return splitByScope(db, taskId, touchedNow, scopeGlobs);
  });

  if (offending.length > 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      setTaskStatus(db, task.id, 'blocked', { blockedReason: 'scope_violation' });
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Rollback failing must not mask the original error.
      }
      throw err;
    }
    return { outcome: 'scope_violation', offending };
  }

  const { exitCode, output } = runVerifyCommand(task.verify_command);

  if (exitCode !== 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      insertVerification(db).run(task.id, task.verify_command, exitCode, output, 'failed');
      setTaskStatus(db, task.id, 'blocked', { blockedReason: 'verification_failed' });
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Rollback failing must not mask the original error.
      }
      throw err;
    }
    return { outcome: 'failed', exitCode, output };
  }

  // Re-diffs against `scopeGlobs` directly (not the gate's `offending`
  // check) rather than reusing gate 1's snapshot — verify_command ran
  // unlocked, above, and may have touched files inside this task's own
  // scope since. Classification, staging, and the commit all run inside
  // the commit lock, on exactly this in-scope set: `git add` followed by
  // `git commit` with no pathspec stages and commits whatever is in the
  // index at that instant, so a neighbor's `git add` landing between this
  // task's `add` and `commit` would otherwise ride along in this task's
  // commit under this task's message, and committing the raw (not
  // scope-restricted) touched set would sweep up a neighbor's untracked,
  // in-scope-for-them files sitting in the same working tree.
  const { touched, kindByPath, commitSha } = withCommitLock(() => {
    const inScope = changedPaths(scopeGlobs.map((glob) => `:(glob)${glob}`));
    return {
      touched: inScope,
      kindByPath: classifyArtifacts(inScope),
      commitSha:
        inScope.length > 0
          ? commitTouchedPaths(inScope, task.commit_message)
          : commitNoOpLayer(task.commit_message),
    };
  });

  let unlocked;
  let intentComplete;
  db.exec('BEGIN IMMEDIATE');
  try {
    insertVerification(db).run(task.id, task.verify_command, exitCode, output, 'passed');

    const runInsertArtifact = insertArtifact(db);
    for (const path of touched) {
      runInsertArtifact.run(task.id, path, kindByPath.get(path), commitSha);
    }

    setTaskStatus(db, task.id, 'complete');
    unlocked = unlockReadyDependents(db, task.id);
    intentComplete = completeIntentIfDone(db, task.intent_id);

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback failing must not mask the original error.
    }
    throw err;
  }

  return { outcome: 'complete', exitCode, output, commitSha, unlocked, intentComplete };
}
