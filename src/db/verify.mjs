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
//      scope_globs, with two classes of path excluded first, because
//      there is no working-tree isolation between concurrent tasks by
//      design and the diff therefore sees far more than this task's own
//      work: paths whose content is unchanged since the task was claimed
//      (they cannot be this task's doing — see attributedToTask), and
//      paths inside any other in-flight task's own declared scope (a
//      concurrent neighbor's legitimate uncommitted edits). Any remaining
//      touched path outside scope refuses to run
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
// transaction is open: every subprocess call in this file happens before
// BEGIN or after COMMIT, never between them.
//
// Every git call goes through `git()` — execFileSync with an argv array,
// no shell. Paths and core.yaml fields reach git as literal arguments,
// so `$(…)`, backticks and the rest are inert data. The one deliberate
// shell in this file is runVerifyCommand, which runs a core-authored
// verify_command that is a shell command by definition.

import { execSync, execFileSync } from 'node:child_process';
import { DB_PATH } from './init.mjs';
import { withCommitLock, LOCK_PATH } from './commitLock.mjs';
import { reapExpiredLeases, pathFingerprint } from './claim.mjs';
import { ensureTaskColumns } from './schema.mjs';
import { FRICTION_DIR } from './friction.mjs';
import { OVERRIDES_DIR } from './overrides.mjs';
import { INTENTS_DIR } from './intent.mjs';

// Build-graph state directories: written by their own command
// (`friction add`, `override add`, `intent add`/`db rebuild`), committed
// by that command's own next step, never by a layer's verify_command. A
// layer's own work never lands here, so a path under one of these is
// never this task's doing regardless of when it changed relative to
// claim time — unlike attributedToTask's fingerprint check, which only
// excludes a path unchanged since claim and so still attributes a
// friction note logged mid-layer (exactly what the loop skill instructs)
// to whichever task happened to be building when it was logged.
const BUILD_GRAPH_STATE_DIRS = [FRICTION_DIR, OVERRIDES_DIR, INTENTS_DIR];

function isBuildGraphStatePath(path) {
  return BUILD_GRAPH_STATE_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

// The build graph file and the commit lock are engine state, written
// only by this CLI, never by an agent — both are excluded from every
// task's scope check (and from artifacts/commits), or verify's own
// writes ahead of and during the verify_command run would trip the very
// check they're performing. Covers SQLite's journal/WAL/SHM sidecar
// files too.
function isEngineStatePath(path) {
  return (
    path === DB_PATH ||
    path.startsWith(`${DB_PATH}-`) ||
    path === LOCK_PATH ||
    isBuildGraphStatePath(path)
  );
}

// Runs git with an argv array and no shell, so every element of `args`
// reaches git as one literal argument. Paths, pathspec globs and commit
// messages all pass through here verbatim: git's own pathspec magic
// (`:(glob)…`) still works, while shell metacharacters in a file name or
// a core.yaml field are just characters.
function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options });
}

// Working-tree diff (relative paths), optionally restricted to `pathspecs`
// via git's own pathspec matching (e.g. `:(glob)packages/db/src/schema/**`)
// — covers modified, added, deleted, and untracked files, everything the
// agent could have touched.
function changedPaths(pathspecs) {
  const scopeArgs = pathspecs ? ['--', ...pathspecs] : [];
  const tracked = git(['diff', '--name-only', 'HEAD', ...scopeArgs]);
  const untracked = git(['ls-files', '--others', '--exclude-standard', ...scopeArgs]);
  const paths = new Set(
    [...tracked.split('\n'), ...untracked.split('\n')].map((p) => p.trim()).filter(Boolean),
  );
  return [...paths].filter((p) => !isEngineStatePath(p));
}

// Narrows a set of touched paths to the ones this task can actually be
// held responsible for: those whose fingerprint differs from the
// claim-time snapshot claim.mjs recorded on the lease. A path identical
// to what it was when the task was claimed did not change during the
// lease, so no amount of dirtiness there is this task's doing — an
// uncommitted friction log, the user's own half-finished edit, a stray
// file some tool left behind before the claim.
//
// This narrows attribution without weakening the gate. A genuine
// out-of-scope change necessarily moves the fingerprint, so it stays
// attributed; the only paths this drops are ones where the task provably
// changed nothing. That rests entirely on pathFingerprint covering
// everything git would commit about a path — its bytes, its type, and
// its executable bit — and not merely its contents; see its comment for
// why a content-only fingerprint let a `chmod +x` walk through. (A task
// that rewrote an identical file over pre-existing dirt is the one
// exempted edge, and it changed nothing to commit either.)
//
// `claimSnapshot` is null for a lease taken before snapshots existed, or
// in a working tree git couldn't read at claim time. Null means "no
// attribution information", and the gate falls back to attributing
// everything dirty — the stricter, pre-snapshot behaviour.
function attributedToTask(touched, claimSnapshot) {
  if (!claimSnapshot) return touched;
  let snapshot;
  try {
    snapshot = JSON.parse(claimSnapshot);
  } catch {
    return touched;
  }
  return touched.filter(
    (path) => !Object.hasOwn(snapshot, path) || snapshot[path] !== pathFingerprint(path),
  );
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
      leased_at = CASE WHEN ? THEN NULL ELSE leased_at END,
      claim_snapshot = CASE WHEN ? THEN NULL ELSE claim_snapshot END
    WHERE id = ?
  `,
  ).run(
    status,
    blockedReason ?? null,
    releasesLease ? 1 : 0,
    releasesLease ? 1 : 0,
    releasesLease ? 1 : 0,
    releasesLease ? 1 : 0,
    taskId,
  );
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
  if (openTask !== undefined) return null;
  db.prepare("UPDATE intents SET status = 'complete' WHERE id = ?").run(intentId);
  // Returns the intent row rather than a bare `true`: this is the one
  // moment the engine can put what was asked for back in front of whoever
  // is closing it, and the CLI prints goal/outcome here as an INTENT
  // CHECK. Nothing else in the circuit compares built work to requested
  // work.
  return db.prepare('SELECT id, goal, outcome FROM intents WHERE id = ?').get(intentId);
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
  const output = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', ...paths]);
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
  git(['add', '--', ...paths], { stdio: 'pipe' });
  git(['commit', '-m', commitMessage], { stdio: 'pipe' });
  return git(['rev-parse', 'HEAD']).trim();
}

// Second paragraph of the no-op layer's commit, so the empty commit reads
// as a deliberate record rather than a stray `--allow-empty`.
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
// empty commit otherwise. Uses the argv-based git() helper like
// commitTouchedPaths, not a shell string: commitMessage comes from
// core.yaml's layer.commit, untrusted input that must never reach a shell.
function commitNoOpLayer(commitMessage) {
  git(['commit', '--allow-empty', '-m', commitMessage, '-m', NO_OP_COMMIT_NOTE], {
    stdio: 'pipe',
  });
  return git(['rev-parse', 'HEAD']).trim();
}

// Puts `taskId` back to `building` under the lease it already holds.
//
// The commit is the last step of verification and the only one that can
// fail after the task has left `building` — git hooks (a lefthook that
// rejects the message), a missing signing key, an unset user.email, any
// repository configuration. Nothing has been recorded when it does, so
// the honest resting place is exactly where the task sat before verify
// ran: still `building`, still leased to the same owner, blocked_reason
// cleared.
//
// Leaving it `verifying` instead strands it with no CLI way out —
// `hedgehog release` only acts on `building`, claimForVerify below only
// accepts `building`, `hedgehog claim` skips it, and `hedgehog renew`
// merely extends the lease. The task would sit unreachable until the
// lease expired and reapExpiredLeases swept it to `blocked`, which is
// itself a state no command re-runs. Rolling back keeps both `hedgehog
// verify` (re-attempt) and `hedgehog release` (hand it back) working.
function rollbackToBuilding(db, taskId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    setTaskStatus(db, taskId, 'building');
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback failing must not mask the original error.
    }
    throw err;
  }
}

// Phase 0: reap expired leases, load `taskId`, assert it's `building` and
// leased to `owner`, then set `verifying` — one small transaction. Throws
// rather than proceeding when the lease doesn't match (including a lease
// that was just reaped for expiring), so a stale or racing caller can't
// run verification against a task it doesn't hold.
function claimForVerify(db, taskId, owner) {
  let task;
  // Before BEGIN, and before any statement below names claim_snapshot: a
  // DB created by an earlier version has no such column, and both the
  // status writes here and the gate's snapshot read depend on it.
  ensureTaskColumns(db);
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
//   { outcome: 'complete', exitCode, output, commitSha, unlocked: [...],
//     intentComplete, completedIntent }
// `completedIntent` is the intent row (id/goal/outcome) when this task
// was the last one of its intent, else null — the CLI prints it back as
// an INTENT CHECK.
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
    // Only what changed during this task's lease is this task's to answer
    // for; everything else in the shared working tree was already there
    // when the task was handed out. The commit set below is deliberately
    // *not* filtered this way — it is scope-restricted already, and a
    // pre-existing dirty file inside the task's own scope is still swept
    // into the layer's commit exactly as before.
    const touchedNow = attributedToTask(changedPaths(), task.claim_snapshot);
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
  //
  // Both commit calls are inside the try: either can fail on a git hook,
  // signing, or identity problem, and neither failure may leave the task
  // parked in `verifying` (see rollbackToBuilding). Re-thrown rather than
  // returned as an outcome so the CLI reports it through its own
  // `Verify failed:` path — the outcomes it knows how to print all end in
  // a state transition this one deliberately doesn't make.
  let touched, kindByPath, commitSha;
  try {
    ({ touched, kindByPath, commitSha } = withCommitLock(() => {
      const inScope = changedPaths(scopeGlobs.map((glob) => `:(glob)${glob}`));
      return {
        touched: inScope,
        kindByPath: classifyArtifacts(inScope),
        commitSha:
          inScope.length > 0
            ? commitTouchedPaths(inScope, task.commit_message)
            : commitNoOpLayer(task.commit_message),
      };
    }));
  } catch (err) {
    rollbackToBuilding(db, task.id);
    throw new Error(
      `Task ${task.id} passed verification but its commit failed, so nothing was ` +
        `recorded. The task is back to \`building\`, still leased to ${owner} — fix ` +
        `the cause (a rejecting git hook, commit signing, or git identity), then ` +
        `re-run \`hedgehog verify ${task.id} --owner ${owner}\`, or hand it back ` +
        `with \`hedgehog release ${task.id} --owner ${owner}\`.\n\n${err.message}`,
    );
  }

  let unlocked;
  let completedIntent;
  db.exec('BEGIN IMMEDIATE');
  try {
    insertVerification(db).run(task.id, task.verify_command, exitCode, output, 'passed');

    const runInsertArtifact = insertArtifact(db);
    for (const path of touched) {
      runInsertArtifact.run(task.id, path, kindByPath.get(path), commitSha);
    }

    setTaskStatus(db, task.id, 'complete');
    unlocked = unlockReadyDependents(db, task.id);
    completedIntent = completeIntentIfDone(db, task.intent_id);

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback failing must not mask the original error.
    }
    throw err;
  }

  return {
    outcome: 'complete',
    exitCode,
    output,
    commitSha,
    unlocked,
    intentComplete: completedIntent !== null,
    completedIntent: completedIntent ?? null,
  };
}
