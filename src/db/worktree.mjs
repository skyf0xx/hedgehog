// `hedgehog plan`'s worktree trigger, `hedgehog merge`, and `hedgehog
// abandon` — running one intent's worth of work in its own `git worktree`
// and branch, merged back (or abandoned) when the intent closes.
//
// The whole design rests on one fact the engine already relies on for
// `hedgehog db rebuild` (rebuild.mjs): the build graph is a pure function
// of committed files plus git history. A worktree therefore never needs to
// merge two live databases — `hedgehog merge` runs `git merge --no-ff` on
// trunk (git merges the *sources*: the intent file, the committed source
// code, any notes/reconciliation records), then `hedgehog db rebuild`
// re-derives trunk's graph from what merged. No DB row ever crosses from
// one worktree's `.hedgehog/hedgehog.db` to another's, or to trunk's.
//
// Trigger: task ids are `<intent>-<layer>` (plan.mjs's taskId), so the
// intent is the natural partition — every task at a layer belongs to
// exactly one intent, and a layer-boundary trigger would instead fan the
// same layer across multiple worktrees writing into the same files.
// `intent_dependencies` (schema.mjs) already declares which intents may
// run concurrently, giving a no-judgment-call readiness rule. An intent
// becomes worktree-eligible (eligibleIntents, below) the moment every
// intent it depends_on is `complete` — plan.mjs's own compiler is
// deliberately never called for such an intent on trunk; bin/cli.mjs's
// planCommand excludes every eligible intent from that call via
// planTasks's `excludeIntentIds` option. Once eligible, the intent's
// tasks are compiled only inside its own worktree — `hedgehog plan`,
// re-invoked as a subprocess with `cwd` set to the new worktree, right
// after `git worktree add` creates it. `ensureDb` (bin/cli.mjs) then
// rebuilds that worktree's own `.hedgehog/hedgehog.db` from
// `.hedgehog/intents/` (already on the new branch, since worktrees share
// the repository's object store and refs) the same way it would for any
// fresh clone — no new code needed for that half, only confirmed by a
// repro rather than assumed (see repro/worktree-trigger.mjs). That
// recursive `hedgehog plan` call must not re-run the trigger itself —
// onHedgehogBranch (below) is the guard that stops it.
//
// `once: true` / core-module tasks (plan.mjs's CORE_INTENT_ID) have no
// real intent to hang a worktree off and must keep building on trunk,
// exactly as today — eligibleIntents excludes `_core` by id, so it only
// ever considers real pending intents.

import { execFileSync } from 'node:child_process';
import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadIntentDependencies } from './plan.mjs';
import { intentFilePath } from './intent.mjs';

export const ABANDONED_DIR = '.hedgehog/abandoned';

// `hedgehog/<intent-id>`, verbatim — unlike plan.mjs#taskId (which always
// upper-cases a task id), `intents.id`/`tasks.intent_id` are stored
// exactly as given to `hedgehog intent add --id` (intent.mjs never
// normalizes case), so a branch name derived from it has to preserve that
// case too: lower-casing here would make `branchName`/`worktreePath`
// non-invertible — hedgehogWorktrees/hedgehogBranches parse an intent id
// back out of a branch name, and could never recover an upper-case letter
// that got silently dropped on the way in.
export function branchName(intentId) {
  return `hedgehog/${intentId}`;
}

// A sibling directory of the repo root, never inside it — a worktree
// nested under the repo it was created from is on every later `git add
// -A`/`git status` inside the parent, which is exactly the confusion
// sibling placement avoids. Named after the repo directory plus the
// intent, so two projects checked out side by side never collide. Same
// no-case-transform rule as branchName, for the same reason.
export function worktreePath(intentId, { repoRoot = process.cwd() } = {}) {
  const repoName = repoRoot.split('/').filter(Boolean).pop() ?? 'repo';
  return resolve(repoRoot, '..', `${repoName}.hedgehog-${intentId}`);
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

function gitOrNull(args, options = {}) {
  try {
    return git(args, options);
  } catch {
    return null;
  }
}

// True when the current checkout is already on a `hedgehog/*` branch —
// i.e. `process.cwd()` is a worktree this feature created, not trunk.
// `hedgehog plan`, re-invoked as a subprocess inside a freshly created
// worktree (bin/cli.mjs#planCommand) to compile that worktree's own
// intent, must not run the eligibility trigger a second time there: the
// intent that worktree exists for reads as "eligible" by exactly the same
// rule that got it a worktree in the first place (its dependency is
// complete, replayed into that worktree's own DB along with everything
// else `ensureDb` recovers), and without this guard `hedgehog plan` would
// try to create a second `hedgehog/<id>` worktree nested inside the
// first — colliding with the branch the outer call already checked out —
// instead of simply compiling the intent's tasks onto the worktree it's
// already standing in.
export function onHedgehogBranch({ repoRoot = process.cwd() } = {}) {
  const branch = gitOrNull(['symbolic-ref', '--short', 'HEAD'], { cwd: repoRoot });
  return branch !== null && branch.startsWith('hedgehog/');
}

// Every real, pending intent (status 'proposed' or 'planned', id not the
// synthesised core intent) that DECLARES at least one `intent_dependencies`
// row and has every one of them `complete` — the readiness rule the issue
// specifies, plus one guard the issue's own reasoning calls for: an intent
// with no declared dependency at all is not "vacuously eligible" the
// moment it's proposed, or a project that has never used
// `intent_dependencies` would have every intent worktree'd on its very
// first `hedgehog plan`, which is exactly the "existing single-working-tree
// flow" acceptance criterion demands stay unchanged. Requiring at least one
// row is what keeps that flow untouched with no separate `--no-worktree`
// flag or opt-out flag to build or teach: a project that never declares
// `--depends-on` on `hedgehog intent add` never trips this path, full
// stop. Ordered by priority, id so a repeat `hedgehog plan` run always
// considers the same intents in the same order.
export function eligibleIntents(db) {
  const intents = db
    .prepare(
      `SELECT * FROM intents WHERE status IN ('proposed','planned') AND id <> '_core'
       ORDER BY priority, id`,
    )
    .all();
  const dependencies = loadIntentDependencies(db);
  const dependsOnByIntent = new Map();
  for (const { intent_id, depends_on_intent_id } of dependencies) {
    if (!dependsOnByIntent.has(intent_id)) dependsOnByIntent.set(intent_id, []);
    dependsOnByIntent.get(intent_id).push(depends_on_intent_id);
  }
  const statusById = new Map(
    db.prepare('SELECT id, status FROM intents').all().map((i) => [i.id, i.status]),
  );

  return intents.filter((intent) => {
    const deps = dependsOnByIntent.get(intent.id);
    if (!deps || deps.length === 0) return false;
    return deps.every((depId) => statusById.get(depId) === 'complete');
  });
}

// True when `intentId` already has a worktree (active) or a committed
// merged/abandoned record — the idempotency check that keeps a repeat
// `hedgehog plan` from creating a second worktree for an intent that
// already has one.
//
// Matched line-exact against `git worktree list --porcelain`'s own
// `branch refs/heads/<name>` line, not a raw substring search: a plain
// `.includes()` against the whole porcelain output would treat intent id
// "foo"'s branch (`refs/heads/hedgehog/foo`) as present whenever
// "foobar"'s worktree exists too, since the former is a substring of the
// latter's own `branch refs/heads/hedgehog/foobar` line.
export function hasWorktree(intentId, { repoRoot = process.cwd() } = {}) {
  const branch = branchName(intentId);
  const list = gitOrNull(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (list === null) return false;
  const target = `branch refs/heads/${branch}`;
  return list.split('\n').some((line) => line === target);
}

// `git worktree add` checks out the branch it creates from the current
// HEAD's *committed* tree — a new worktree has no access to whatever is
// only sitting uncommitted in trunk's working directory. `hedgehog intent
// add` writes `.hedgehog/intents/<id>.json` to disk but does not commit
// it (every loop skill's own "commit that file" instruction is what
// closes that gap today), so an intent added and immediately planned
// without an intervening commit would get a worktree with no intent file
// inside it — `ensureDb`'s own rebuild would then have nothing to
// compile from. Checked before creating the worktree at all: failing
// loudly here, with the fix named, beats a worktree that silently
// compiles nothing.
export function intentFileCommitted(intentId, { repoRoot = process.cwd() } = {}) {
  const path = intentFilePath(intentId);
  // `git status --porcelain -- <path>` on a path that was never written
  // (a typo'd intent id, or a file that plain doesn't exist) also returns
  // empty output and exit 0 — indistinguishable, on its own, from "clean,
  // tracked, committed". `git ls-files --error-unmatch` is checked first
  // so a nonexistent or untracked path is caught here instead of being
  // read as committed and letting createWorktree proceed into a worktree
  // with no intent file inside it.
  const tracked = gitOrNull(['ls-files', '--error-unmatch', '--', path], { cwd: repoRoot });
  if (tracked === null) return false;

  const output = gitOrNull(['status', '--porcelain', '--', path], { cwd: repoRoot });
  // null means git itself couldn't run (not a repo) — treated as "not
  // committed" so the caller's own error path fires rather than this
  // silently reporting success on a check it couldn't perform.
  if (output === null) return false;
  // Empty output from `git status --porcelain -- <path>` means the path
  // matches HEAD exactly — tracked and with no pending change, which is
  // the definition of "committed" this check needs. Any status line
  // (staged, modified, or untracked '??') means it isn't.
  return output.trim() === '';
}

// True when `branch` already exists as a ref, regardless of whether any
// worktree currently has it checked out — `git branch --list <branch>`
// prints the ref's name when it exists and nothing when it doesn't.
function branchExists(branch, { repoRoot = process.cwd() } = {}) {
  const output = gitOrNull(['branch', '--list', branch], { cwd: repoRoot });
  return output !== null && output.trim() !== '';
}

// Creates a sibling worktree checked out onto `hedgehog/<intent-id>`, off
// the current HEAD when the branch is new. A caller must check
// hasWorktree first (this feature's "check before acting" contract) —
// but hasWorktree only reports an *active* worktree, so it's true even
// when the branch survives with none: a worktree directory removed by
// hand (`rm -rf`, a lost machine) without an intervening `hedgehog
// merge`/`hedgehog abandon` leaves `hedgehog/<intent-id>` behind as an
// orphaned ref with no worktree entry pointing at it
// (worktreeStatus's own orphan case). `-b` requires a *new* branch name
// and fails loudly against that survivor, so this checks for it first and
// reattaches to the existing branch instead (`git worktree add <path>
// <branch>`, no `-b`) — the exact by-hand recovery worktreeStatus already
// tells the user to run, done automatically instead of leaving the intent
// permanently excluded from trunk with no self-heal.
export function createWorktree(intentId, { repoRoot = process.cwd() } = {}) {
  const branch = branchName(intentId);
  const path = worktreePath(intentId, { repoRoot });
  if (branchExists(branch, { repoRoot })) {
    git(['worktree', 'add', path, branch], { cwd: repoRoot });
  } else {
    git(['worktree', 'add', '-b', branch, path], { cwd: repoRoot });
  }
  return { branch, path };
}

// Every worktree git itself knows about, parsed from `git worktree list
// --porcelain` — path, branch (null for a detached one, which this feature
// never creates but a user could), and HEAD sha. The main worktree (the
// repo root itself) is included like any other; callers that only want
// the ones this feature created filter by branch prefix.
export function listGitWorktrees({ repoRoot = process.cwd() } = {}) {
  const output = gitOrNull(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (output === null) return [];

  const entries = [];
  let current = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length), branch: null, head: null };
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (current) entries.push(current);
  return entries;
}

// The subset of listGitWorktrees whose branch is `hedgehog/<intent-id>` —
// every worktree this feature is responsible for, each annotated with the
// intent id its branch name encodes. Extracted verbatim, no case
// transform — branchName never lower-cased it going in, so recovering it
// case-for-case here is what lets the id be used directly against
// `intents`/`tasks.intent_id`, neither of which is ever case-normalized.
export function hedgehogWorktrees({ repoRoot = process.cwd() } = {}) {
  return listGitWorktrees({ repoRoot })
    .filter((w) => w.branch && w.branch.startsWith('hedgehog/'))
    .map((w) => ({ ...w, intentId: w.branch.slice('hedgehog/'.length) }));
}

// Every `hedgehog/*` branch, whether or not git still has a worktree
// checked out onto it — `git worktree remove` (this feature's own path)
// deletes both together, but a worktree directory removed by hand
// (`rm -rf`, a lost machine) leaves the branch behind with no worktree
// entry for it. `git worktree list --porcelain` reports the pair while
// both exist and silently omits a removed one, so the branch list is the
// wider net: every id `hedgehog status` has to be able to flag as orphaned
// has to first be found here, not just in listGitWorktrees.
function hedgehogBranches({ repoRoot = process.cwd() } = {}) {
  const output = gitOrNull(['branch', '--list', 'hedgehog/*', '--format=%(refname:short)'], {
    cwd: repoRoot,
  });
  if (output === null || output === '') return [];
  return output
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .map((branch) => ({ branch, intentId: branch.slice('hedgehog/'.length) }));
}

// `hedgehog status`'s worktree section: every `hedgehog/<id>` branch,
// classified active (a worktree directory still exists for it) or
// orphaned (the branch or directory is gone with no merged/abandoned
// record to explain why — the directory case surfaces as a
// listGitWorktrees entry with no matching path on disk is unreachable
// through git's own listing, so what actually distinguishes orphaned here
// is "branch exists, no active worktree entry, and the intent was never
// recorded complete or abandoned").
//
// `db` is the trunk graph (open by the CLI's own ambient contract, the
// same one every other status.mjs field reads against) — an intent's
// `status` there is what distinguishes "this finished normally, the
// worktree is just gone because merge cleaned it up before this ran" from
// a genuine orphan.
export async function worktreeStatus(db, { repoRoot = process.cwd(), abandonedDir = ABANDONED_DIR } = {}) {
  const active = hedgehogWorktrees({ repoRoot });
  const activeIds = new Set(active.map((w) => w.intentId));
  const branches = hedgehogBranches({ repoRoot });
  const abandoned = await loadAbandoned(abandonedDir);

  const statusById = new Map(
    db.prepare('SELECT id, status FROM intents').all().map((i) => [i.id, i.status]),
  );

  const orphaned = [];
  for (const { branch, intentId } of branches) {
    if (activeIds.has(intentId)) continue; // has a live worktree — not orphaned
    if (abandoned.has(intentId)) continue; // abandon removes the branch, but a
    // record surviving alongside a leftover branch (abandon's own cleanup
    // failed, per abandonCommand's own warning path) explains itself.
    if (statusById.get(intentId) === 'complete') continue; // merge removes the
    // branch too; same reasoning for a leftover after a merge whose own
    // cleanup step failed.
    orphaned.push({ branch, intentId });
  }

  return { active, orphaned };
}

// ── abandonment ──────────────────────────────────────────────────────

// Lower-cased for the filename only — a filesystem convenience, same as
// reconcile.mjs#reconciledFilePath and notes.mjs#notesFilePath, neither of
// which is read back to recover the id (the JSON body's own "intent"
// field is the source of truth for that, read verbatim below).
function abandonedFilePath(intentId, abandonedDir = ABANDONED_DIR) {
  return `${abandonedDir}/${intentId.toLowerCase()}.json`;
}

function validateAbandoned(record, path) {
  if (record === null || typeof record !== 'object') {
    throw new Error(`${path}: abandonment record must be a JSON object`);
  }
  const { intent, reason, abandoned_at: abandonedAt } = record;

  if (!intent || typeof intent !== 'string') {
    throw new Error(`${path}: abandonment record requires an "intent" id (string)`);
  }
  // No case normalization: unlike plan.mjs#taskId (always upper-case),
  // `intents.id` is stored exactly as given to `hedgehog intent add --id`
  // (intent.mjs never touches its case), and this value is used directly
  // against that column in applyAbandonment/replayAbandonments below.

  if (!reason || typeof reason !== 'string') {
    throw new Error(
      `${path}: abandonment "${intent}" requires a "reason" (string) — the permanent record of why this intent was dropped`,
    );
  }
  if (!abandonedAt || typeof abandonedAt !== 'string') {
    throw new Error(`${path}: abandonment "${intent}" requires an "abandoned_at" timestamp (string)`);
  }

  return { intent, reason, abandoned_at: abandonedAt };
}

// Every *.json in `abandonedDir`, validated, as a Map from intent id to its
// record. Absent directory reads as "nothing abandoned" — the same
// contract every other committed-record loader in this engine follows
// (overrides.mjs#loadOverrides, reconcile.mjs#loadReconciliations,
// notes.mjs#loadNotes).
export async function loadAbandoned(abandonedDir = ABANDONED_DIR) {
  let entries;
  try {
    entries = await readdir(abandonedDir);
  } catch {
    return new Map();
  }

  const byIntent = new Map();
  for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
    const path = `${abandonedDir}/${name}`;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      throw new Error(`could not read abandonment file ${path}: ${err.message}`, { cause: err });
    }
    const record = validateAbandoned(parsed, path);
    byIntent.set(record.intent, record);
  }
  return byIntent;
}

// Writes one abandonment record via temp file + rename — reconcile.mjs's
// exact pattern, for the exact same reason: a crash mid-write must never
// leave a half-written file for loadAbandoned to trip on. Refuses to
// overwrite: an intent is abandoned once, and a second "abandon" for the
// same id is a mistake worth stopping for, not a second fact to record.
export async function writeAbandonedFile(record, abandonedDir = ABANDONED_DIR) {
  const path = abandonedFilePath(record.intent, abandonedDir);
  try {
    await readFile(path, 'utf8');
    throw new Error(
      `${path} already exists — ${record.intent} is already recorded as abandoned.`,
    );
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  await mkdir(abandonedDir, { recursive: true });
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

// Shared by applyAbandonment (live) and replayAbandonments (rebuild
// replay) — both reset the same columns for the same reason: an abandoned
// intent's tasks must not be left `building`/`verifying`/leased, since
// `hedgehog plan` only ever recompiles `proposed`/`planned` intents and a
// stale lease would otherwise sit there forever with no live command left
// to release it. One prepared statement, run by both callers, so the two
// paths can't silently diverge on which columns a reset touches.
function resetIntentTasksToPlanned(db, intentId) {
  return db
    .prepare(
      `UPDATE tasks SET status = 'planned', blocked_reason = NULL,
        lease_owner = NULL, lease_expires_at = NULL, leased_at = NULL,
        claim_snapshot = NULL
       WHERE intent_id = ? AND status <> 'planned'
       RETURNING id`,
    )
    .all(intentId);
}

// Deletes every `intent_dependencies` row naming `intentId` on either
// side. An abandoned intent is reset to `planned` with no compiled tasks
// on trunk, so a `depends_on` edge pointing at it (something else declared
// as depending on it) or away from it (its own declared dependency) is
// both stale the moment abandonment lands: `eligibleIntents` (this file)
// reads that table directly to decide worktree eligibility, and a row
// surviving abandonment lets an unrelated intent read as "its dependency
// is satisfied" against an intent that no longer has any real status to
// satisfy anything with, or lets this intent re-read as eligible against a
// dependency it no longer declares. Re-adding the same id later
// (`hedgehog intent add --file` with a JSON that still declares the
// dependency) recreates the row from that file, same as any first-time
// add — this only clears what abandonment made stale, not what a future
// add might legitimately restate.
function clearIntentDependencies(db, intentId) {
  db.prepare(
    'DELETE FROM intent_dependencies WHERE intent_id = ? OR depends_on_intent_id = ?',
  ).run(intentId, intentId);
}

// Resets every task of `intentId` to `planned` on whichever DB `db` is
// open against (trunk, by the CLI's own contract — see abandonCommand),
// clears any lease, and reopens the intent itself to `planned` so a later
// `hedgehog plan` recompiles it (or, if its tasks were never compiled on
// trunk at all — the normal case, since an eligible intent's tasks are
// only ever compiled inside its own worktree — this is simply a no-op on
// tasks that don't exist yet). Mirrors reconcile.mjs#applyReconciliation's
// shape: the committed file is written first, this is applied second.
//
// Also clears every `intent_dependencies` row naming this intent, on
// either side (clearIntentDependencies, above) — an abandoned intent's own
// declared dependency and any other intent's dependency on it are both
// stale the instant it resets to `planned` with no shipped work.
//
// Refuses an intent already `complete` (merged, real shipped work) —
// same reasoning as reconcile.mjs#confirmReconciliation refusing an
// already-complete task: applyAbandonment resets tasks to 'planned'
// unconditionally otherwise, which would un-ship already-merged work on
// nothing more than a typo'd or misremembered intent id. abandonCommand
// checks this before ever writing the committed abandonment file (so a
// refused abandonment leaves no record on disk), but this function
// carries its own guard too — replayAbandonments (rebuild replay) calls
// the same reset path directly and must not regress a `complete` intent
// either, whatever wrote the record it's replaying.
export function applyAbandonment(db, intentId) {
  const intent = db.prepare('SELECT id, status FROM intents WHERE id = ?').get(intentId);
  if (intent?.status === 'complete') {
    throw new Error(
      `intent "${intentId}" is already complete — abandoning it would reset merged, shipped work back to planned`,
    );
  }
  const resetTasks = resetIntentTasksToPlanned(db, intentId);
  clearIntentDependencies(db, intentId);

  if (intent) {
    db.prepare("UPDATE intents SET status = 'planned' WHERE id = ?").run(intentId);
  }

  return { intentExisted: intent !== undefined, resetTaskIds: resetTasks.map((r) => r.id) };
}

// Replays `.hedgehog/abandoned/*.json` during `hedgehog db rebuild`
// (rebuild.mjs) — the abandonment's committed source, the same role
// reconcile.mjs's replayReconciliations plays for a confirmed
// reconciliation. Without this, a rebuild that recompiles the intent from
// its still-present `.hedgehog/intents/<id>.json` file would silently
// un-abandon it: planTasks writes every task `planned` on first compile
// regardless, so the *status* would happen to already read correctly, but
// the intent's own row would read 'active' (planTasks flips a freshly
// compiled intent to 'active') with no record anywhere of why it stopped —
// exactly the silent-drop shape the debt/decisions prerequisite fixed for
// notes. This keeps the intent's status 'planned' (not 'active') after
// replay and returns the ids touched, for the CLI to report.
//
// A record whose intent is `complete` on the graph being rebuilt (e.g. a
// stale abandonment file left behind after the intent was later merged by
// some other route) is skipped, not applied — a rebuild must never regress
// shipped work back to 'planned', mirroring applyAbandonment's own guard.
// Skipped rather than thrown, since a rebuild has to finish and report
// rather than abort over one stale committed file; folded into `orphaned`
// so dbRebuildCommand's existing "abandonments without an intent" warning
// covers it without a third bucket to teach the CLI to print.
export function replayAbandonments(db, abandonments) {
  const setPlanned = db.prepare("UPDATE intents SET status = 'planned' WHERE id = ?");
  const getIntent = db.prepare('SELECT status FROM intents WHERE id = ?');

  const replayed = [];
  const orphaned = [];
  for (const [intentId, record] of abandonments) {
    const intent = getIntent.get(intentId);
    if (intent === undefined || intent.status === 'complete') {
      orphaned.push(intentId);
      continue;
    }
    setPlanned.run(intentId);
    resetIntentTasksToPlanned(db, intentId);
    clearIntentDependencies(db, intentId);
    replayed.push({ intentId, reason: record.reason });
  }
  return { replayed, orphaned };
}

// ── merge ────────────────────────────────────────────────────────────

// Every task compiled for `intentId` and its status, read from `db` — the
// worktree's own graph, opened by the caller with `cwd` set to the
// worktree path. Empty when the intent's tasks were never compiled there
// (a worktree created but never planned inside — shouldn't happen through
// the normal `hedgehog plan` trigger, but distinguishable from "compiled
// and complete" rather than silently treated the same).
export function intentTaskStatuses(db, intentId) {
  return db.prepare('SELECT id, status FROM tasks WHERE intent_id = ? ORDER BY id').all(intentId);
}

// `hedgehog merge`'s precondition: every task compiled for this intent, in
// the worktree's own graph, is `complete`. Checked before merging, not
// after — merging first and discovering incomplete work in the rebuilt
// trunk graph would leave a half-merged branch to untangle by hand.
export function intentReadyToMerge(db, intentId) {
  const tasks = intentTaskStatuses(db, intentId);
  if (tasks.length === 0) {
    return { ready: false, reason: 'no_tasks', tasks };
  }
  const incomplete = tasks.filter((t) => t.status !== 'complete');
  if (incomplete.length > 0) {
    return { ready: false, reason: 'incomplete_tasks', tasks, incomplete };
  }
  return { ready: true, tasks };
}

// Runs `git merge --no-ff hedgehog/<intent-id>` against whichever
// worktree/checkout `repoRoot` is (trunk, by the CLI's own contract). Not
// wrapped in a try/catch that swallows the error — a real conflict has to
// surface to the caller with git's own message, since resolving it is a
// human's job this command does not attempt.
export function mergeBranch(intentId, { repoRoot = process.cwd() } = {}) {
  const branch = branchName(intentId);
  git(
    ['merge', '--no-ff', branch, '-m', `merge: ${branchName(intentId)}`],
    { cwd: repoRoot },
  );
  return { branch };
}

// Removes the worktree directory and, optionally, its branch. `git
// worktree remove` refuses a dirty worktree by default — this call does
// not force it, since an uncommitted change in the worktree at merge time
// is exactly the situation `intentReadyToMerge` above should already have
// caught (an incomplete task leaves the graph non-`complete`), and forcing
// past it would discard that work rather than surface it.
export function removeWorktree(worktreePathValue, { repoRoot = process.cwd(), removeBranch = true, branch } = {}) {
  git(['worktree', 'remove', worktreePathValue], { cwd: repoRoot });
  if (removeBranch && branch) {
    git(['branch', '-D', branch], { cwd: repoRoot });
  }
}
