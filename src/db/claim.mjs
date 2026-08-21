// `hedgehog claim` / `release` / `renew` / `retry` — lease-based task
// assignment and the one transition back out of `blocked`. See
// hedgehog-persistent-build-graph.md, "Claims", and the lease/claim
// columns added to `tasks` in schema.mjs.
//
// Every write in this file keeps the schema's lease invariant —
// `CHECK ((lease_owner IS NULL) = (status NOT IN ('building','verifying')))`
// — by setting status and the three lease columns in the same UPDATE:
// a task entering `building` gets an owner, and a task leaving it (to
// ready, planned, blocked) has all three cleared.

import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { inTransaction } from './init.mjs';
import { conflicts } from './conflict.mjs';
import { incompleteDependencies } from './next.mjs';
import { ensureTaskColumns } from './schema.mjs';

// ── Claim-time working-tree snapshot ──────────────────────────────────
//
// The scope gate in verify.mjs can only see *that* the working tree is
// dirty, never *who* dirtied it — there is one working tree shared by
// every concurrent task, the agent, the user, and whatever hooks the
// surrounding harness runs. Judging a task by the whole dirty tree
// therefore blames whoever verifies first for anything already sitting
// there: an uncommitted friction log, a half-finished edit of the user's,
// a neighbour's stray write.
//
// So the claim records what the tree already looked like. A path that is
// identical to what it was at claim time did not change during this
// task's lease, and cannot be this task's doing. Anything else still is
// — which is why this narrows attribution without ever letting a real
// out-of-scope write through: a fingerprint that moved is attributed.
//
// "Identical" has to mean identical *to git*, not merely byte-identical
// in content. Git tracks a file's type and its one permission bit as
// well as its bytes, so a `chmod +x` or a retargeted symlink is a real,
// committable change to an out-of-scope path — and a fingerprint blind
// to those would let the gate be stepped around by making exactly that
// kind of change to a path that happened to be dirty already.

// Sentinel fingerprint for a path git reports as dirty but that can't be
// examined at all — a deletion, most often. Distinct from every real
// fingerprint below, so "deleted at claim time, still deleted now"
// matches and "present at claim time, deleted now" doesn't.
const ABSENT = 'absent';

const sha1 = (data) => createHash('sha1').update(data).digest('hex');

// Fingerprints a working-tree path over everything git would record
// about it, and nothing it wouldn't:
//
//   - the entry's type, as a prefix, so swapping a file for a symlink to
//     an identical payload never fingerprints the same;
//   - for a symlink, its target — git stores a symlink as a blob holding
//     the target string, so retargeting one is a content change. Read
//     with readlink rather than following the link: following it would
//     fingerprint whatever it points at, which is how a retarget to a
//     same-content file slipped through;
//   - for a regular file, the owner-execute bit (git's 100644 vs 100755
//     distinction) and the bytes. Only that one bit: every other
//     permission bit is invisible to git, and folding those in would
//     make the gate fire on changes git itself never sees.
//
// A path deleted and recreated identically fingerprints the same, which
// is correct — git calls that path clean, so it never reaches the gate.
//
// Cost is one lstat plus one read per dirty path, no subprocess, so this
// stays cheap over a large working tree.
//
// Exported so verify.mjs fingerprints paths the exact same way they were
// fingerprinted here — two implementations that drifted would silently
// mis-attribute.
export function pathFingerprint(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return ABSENT;
  }
  try {
    if (stats.isSymbolicLink()) return `l:${sha1(readlinkSync(path))}`;
    if (stats.isFile()) return `f${stats.mode & 0o100 ? '755' : '644'}:${sha1(readFileSync(path))}`;
    // Anything else (fifo, socket, device, directory) is not something
    // git can hold, but it is something a path can be turned into —
    // record the type so that turning it into one is still a change.
    return `o:${(stats.mode & 0o170000).toString(8)}`;
  } catch {
    return ABSENT;
  }
}

// Every path the working tree is currently dirty at, relative to the repo
// root: tracked modifications and deletions (`git diff HEAD`) plus
// untracked files (`git ls-files --others`), the same two reads verify's
// own `changedPaths` makes. Deliberately unfiltered — engine state and all
// — because a path recorded here only ever makes the gate more forgiving
// of something it already ignored.
function dirtyPaths() {
  const run = (args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const tracked = run(['diff', '--name-only', 'HEAD']);
  const untracked = run(['ls-files', '--others', '--exclude-standard']);
  return [
    ...new Set(
      [...tracked.split('\n'), ...untracked.split('\n')].map((p) => p.trim()).filter(Boolean),
    ),
  ];
}

// The JSON snapshot stored on the lease, or null when the working tree
// can't be read at all (not a git repo, no commits yet). null is the
// honest answer rather than an empty snapshot: an empty snapshot claims
// "nothing was dirty", which would attribute the whole tree to the task,
// whereas null tells the gate it has no attribution information and to
// fall back to its pre-snapshot behaviour.
export function snapshotWorkingTree() {
  try {
    const snapshot = {};
    for (const path of dirtyPaths()) snapshot[path] = pathFingerprint(path);
    return JSON.stringify(snapshot);
  } catch {
    return null;
  }
}

// Same no-incomplete-dependency shape as next.mjs's READY_TASK_SQL, without
// the LIMIT 1 — claimTasks may take more than one candidate per call.
//
// `exclusive DESC` within a priority band is a scheduling fix, not a
// preference. conflicts() reports 'exclusive' if *either* side is
// exclusive, so the fan-out loop below can only ever accept an exclusive
// candidate while `against` is still empty — i.e. only if it is the very
// first candidate considered. Ordered by id alone, an exclusive task is
// skipped on every call for as long as any non-exclusive candidate sorts
// ahead of it, and since each completing task unlocks its successor there
// is nearly always one. An exclusive task that is a module's *first*
// layer therefore holds that entire module back until the rest of the
// build runs out of lower-sorting work. Taking exclusive candidates first
// within their band costs nothing in throughput — an exclusive task runs
// alone whenever it runs, so moving it earlier only moves the same
// serialized step forward and unblocks its dependents sooner.
const CLAIMABLE_TASKS_SQL = `
  SELECT t.* FROM tasks t
  WHERE t.status IN ('planned', 'ready')
    AND t.lease_owner IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM dependencies d
      JOIN tasks dep ON dep.id = d.depends_on_task_id
      WHERE d.task_id = t.id AND dep.status <> 'complete'
    )
  ORDER BY t.priority, t.exclusive DESC, t.id
`;

// Exported for ready.mjs, which walks the identical candidate set to
// simulate this same fan-out without claiming anything.
export function findClaimableTasks(db) {
  return db.prepare(CLAIMABLE_TASKS_SQL).all();
}

// Tasks another call already holds a lease on — the conflict check's other
// seed alongside the batch being accepted in this call. Exported for
// ready.mjs, which needs the same seed to simulate the fan-out accurately.
export function findInFlightTasks(db) {
  return db.prepare(`SELECT * FROM tasks WHERE status IN ('building', 'verifying')`).all();
}

function loadTask(db, taskId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
}

// Expired leases go to `blocked`/`lease_expired`, never back to `ready` —
// a dead agent may have left half-written files, and silently re-handing
// that task to a fresh agent starts it from a mess it can't see. Exported
// for verify.mjs's claimForVerify, which reaps its own task's lease
// before checking ownership — reaping is otherwise lazy (only run here,
// from claimTasks), so a build that outlives its lease with no
// concurrent `claim` call in the interim would otherwise reach `verify`
// with a technically-expired lease that still matches status/lease_owner
// and sail through unreaped.
//
// Returns the ids it just flipped, as a Set — claimTasks's stop-the-line
// check uses this to tell a block this very call produced from one that
// was already sitting there, so a dead agent's lease lapsing doesn't
// itself become the reason every other module's fan-out refuses.
export function reapExpiredLeases(db) {
  const rows = db
    .prepare(
      `
    UPDATE tasks
    SET status = 'blocked', blocked_reason = 'lease_expired',
        lease_owner = NULL, lease_expires_at = NULL, leased_at = NULL,
        claim_snapshot = NULL
    WHERE status IN ('building', 'verifying') AND lease_expires_at < datetime('now')
    RETURNING id
  `,
    )
    .all();
  return new Set(rows.map((r) => r.id));
}

// The atomic claim primitive: the WHERE clause re-checks status and
// lease_owner at UPDATE time, so RETURNING a row (rather than undefined)
// is the only proof this call won the race against a concurrent claim.
const claimOne = (db) =>
  db.prepare(`
    UPDATE tasks SET status = 'building', lease_owner = ?, leased_at = datetime('now'),
      lease_expires_at = datetime('now', '+' || ? || ' minutes'),
      claim_snapshot = ?
    WHERE id = ? AND status IN ('planned','ready') AND lease_owner IS NULL
    RETURNING id
  `);

// Every `blocked` task in the graph, regardless of module or reason —
// the fan-out claim's stop-the-line check. Ordered the same as the
// NEEDS ATTENTION list in status.mjs, so the two never disagree about
// which tasks are outstanding.
function findBlockedTasks(db) {
  return db.prepare(`SELECT * FROM tasks WHERE status = 'blocked' ORDER BY priority, id`).all();
}

// Claims up to `count` ready tasks for `owner`, returning
// `{ claimed, blocked }`. `count` is a maximum, not a promise — `claimed`
// may hold fewer tasks than `count`, or none. `blocked` is non-empty only
// on the stop-the-line refusal below, in which case `claimed` is always
// empty.
//
// Stop-the-line: if any task anywhere in the graph was already `blocked`
// before this call, the fan-out refuses to claim anything at all, in any
// module — a blocked task needs a human/agent decision (retry after a
// fix, or leave it), and handing out fresh work around it makes that easy
// to ignore indefinitely. Deliberately stricter than dependency-based
// blocking: an unrelated module isn't literally stuck on the blocked
// task, but the fan-out stops anyway until it's retried. A targeted
// `hedgehog claim <task-id>` (claimTask, below) is exempt — that's how
// the blocked task itself gets reclaimed after `hedgehog retry`.
//
// "Already blocked" excludes a lease this same call's reapExpiredLeases
// just flipped: a dead agent's lease can lapse on an unrelated module,
// and the first `claim` call after that lapse is whichever one happens to
// discover it. That call still claims normally; the reaped task still
// lands in `blocked`/`lease_expired` and still needs `hedgehog retry`
// before it's claimable — only this one call's refusal is skipped. Every
// `claim` call after it sees the same task still blocked and stops as
// usual.
//
// Fan-out keeps the batch mutually non-conflicting, and non-conflicting
// with every task already in flight, per conflict.mjs's
// exclusive/scope/verify predicate (item 11): a candidate that conflicts
// with anything already accepted into this batch *or* already
// building/verifying is left ready for a future call rather than claimed
// alongside it. CLAIMABLE_TASKS_SQL's `lease_owner IS NULL` only keeps an
// in-flight task out of the candidate pool itself — it does not compare a
// candidate against that task's scope or verify radius, so in-flight
// tasks must be seeded into the conflict check explicitly. A race lost to
// a concurrent claimer (the atomic UPDATE returns undefined) is skipped
// and doesn't count against `count` — it neither joins the batch nor
// short-circuits the loop.
export function claimTasks(db, { owner, count = 1, leaseMinutes = 45 }) {
  ensureTaskColumns(db);
  // Read the working tree *before* BEGIN — this file keeps verify.mjs's
  // rule that no subprocess runs with a sqlite transaction open. One
  // snapshot serves the whole batch: they all start from the same tree.
  // Taking it a moment early can only miss a path dirtied in between,
  // which leaves that path attributed — the strict direction.
  const claimSnapshot = snapshotWorkingTree();

  return inTransaction(db, () => {
    const justReaped = reapExpiredLeases(db);

    const blocked = findBlockedTasks(db).filter((task) => !justReaped.has(task.id));
    if (blocked.length > 0) {
      return { claimed: [], blocked };
    }

    const candidates = findClaimableTasks(db);
    const inFlight = findInFlightTasks(db);
    const runClaim = claimOne(db);
    const claimed = [];

    for (const candidate of candidates) {
      if (claimed.length >= count) break;
      const against = [...inFlight, ...claimed];
      if (against.some((accepted) => conflicts(candidate, accepted) !== null)) continue;
      const result = runClaim.get(owner, leaseMinutes, claimSnapshot, candidate.id);
      if (result === undefined) continue; // lost the race, skip
      claimed.push(loadTask(db, candidate.id));
    }

    return { claimed, blocked: [] };
  });
}

// Claims one named task for `owner`, bypassing the fan-out's ordering
// without bypassing any of its safety rules. The batch claim above walks
// candidates in `priority, id` order and takes the first non-conflicting
// set, which means a task that conflicts with everything — an
// `exclusive: true` layer — is only ever handed out when it happens to
// sort ahead of every other candidate. Any non-exclusive candidate
// sorting before it takes the slot instead, on every call, however many
// times the loop runs: the exclusive task starves. This is the operator's
// way to say which task to hand out, rather than editing the lease into
// the database by hand.
//
// The four refusals below are exactly the fan-out's own preconditions,
// checked against one named task instead of a candidate list, and each
// one returns a reason rather than a bare false — a caller that can't say
// *why* nothing was claimed is the silent-failure this command exists to
// replace:
//   no_such_task            — the id doesn't name a row
//   not_claimable           — wrong status, or already leased
//   incomplete_dependencies — a dependency isn't `complete` yet
//   conflict                — conflicts with a task already in flight
//   race_lost               — a concurrent claim won the atomic UPDATE
export function claimTask(db, taskId, { owner, leaseMinutes = 45 }) {
  ensureTaskColumns(db);
  // Same rule as claimTasks: read before BEGIN, no subprocess inside a
  // transaction.
  const claimSnapshot = snapshotWorkingTree();

  return inTransaction(db, () => {
    reapExpiredLeases(db);

    const task = loadTask(db, taskId);
    if (task === undefined) return { claimed: false, reason: 'no_such_task' };

    if (!['planned', 'ready'].includes(task.status) || task.lease_owner !== null) {
      return { claimed: false, reason: 'not_claimable', task };
    }

    const incomplete = incompleteDependencies(db, taskId);
    if (incomplete.length > 0) {
      return { claimed: false, reason: 'incomplete_dependencies', task, incomplete };
    }

    // Conflicting with something already building/verifying is the one
    // refusal a targeted claim must keep: the whole point of the
    // conflict predicate is that two overlapping tasks in one working
    // tree corrupt each other's scope check and commit. Waiting for the
    // neighbor to finish (or releasing it) is the fix, not overriding
    // this.
    const conflicting = [];
    for (const other of findInFlightTasks(db)) {
      if (other.id === task.id) continue;
      const kind = conflicts(task, other);
      if (kind !== null) conflicting.push({ task: other, kind });
    }
    if (conflicting.length > 0) {
      return { claimed: false, reason: 'conflict', task, conflicting };
    }

    const result = claimOne(db).get(owner, leaseMinutes, claimSnapshot, task.id);
    if (result === undefined) return { claimed: false, reason: 'race_lost', task };

    return { claimed: true, task: loadTask(db, task.id) };
  });
}

// Returns a `blocked` task to `planned`, so it can be claimed and built
// again. Every blocked_reason is eligible: a failed verification and a
// scope violation are the loop's expected failure cases (build, gate
// rejects, fix, retry), and a reaped lease is a dead agent's task that a
// live one has to be able to pick back up. Without this there is no
// transition out of `blocked` at all — `releaseTask` only accepts
// `building`, and `verifyTask` refuses anything that isn't `building`
// and leased, so a blocked task is unreachable by every other command.
//
// `planned` rather than `ready`: it's the status `plan.mjs` writes for a
// task that hasn't been built yet, and the readiness SELECT accepts both,
// so the task re-enters the queue exactly where a freshly compiled one
// would — still subject to its dependencies being complete.
export function retryTask(db, taskId) {
  return inTransaction(db, () => {
    // Same reason verifyTask reaps before its own status check: a task
    // whose lease expired with no intervening `claim` call is still
    // sitting in `building`/`verifying` here, not yet swept to `blocked`
    // — without this, retry on that task reads "not blocked" and refuses,
    // even though the lease is in fact dead and this is exactly the
    // situation retry exists to recover from.
    reapExpiredLeases(db);
    const task = loadTask(db, taskId);
    if (task === undefined) return { retried: false, reason: 'no_such_task' };
    if (task.status !== 'blocked') return { retried: false, reason: 'not_blocked', task };

    const result = db
      .prepare(
        `
        UPDATE tasks SET status = 'planned', blocked_reason = NULL,
          lease_owner = NULL, lease_expires_at = NULL, leased_at = NULL
        WHERE id = ? AND status = 'blocked'
        RETURNING id
      `,
      )
      .get(taskId);

    if (result === undefined) return { retried: false, reason: 'not_blocked', task };

    return { retried: true, from: task.blocked_reason, task: loadTask(db, taskId) };
  });
}

// The full transitive closure of tasks that depend on `taskId`, directly
// or through another dependent — the same walk verify.mjs's
// loadDirectDependents feeds one layer at a time, extended to every
// layer downstream. A Correction Protocol reopen has to see this whole
// chain: an upstream task built on wrong output can have several
// already-complete layers stacked on it, and every one of them was
// built against the thing that's about to change.
function loadTransitiveDependents(db, taskId) {
  const directDependents = db.prepare(
    'SELECT task_id AS id FROM dependencies WHERE depends_on_task_id = ?',
  );
  const seen = new Set([taskId]);
  const downstream = [];
  let frontier = [taskId];
  while (frontier.length > 0) {
    const next = [];
    for (const id of frontier) {
      for (const row of directDependents.all(id)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        downstream.push(row.id);
        next.push(row.id);
      }
    }
    frontier = next;
  }
  return downstream;
}

// Reopens `taskId` for a Correction Protocol fix: moves a `complete` task
// (and every `complete` task downstream of it, transitively) back to
// `planned`, so the fix and every layer built on top of it are rebuilt
// and re-verified in dependency order, the same as any other `planned`
// task.
//
// This is deliberately not folded into `retryTask` as an automatic extra
// case: `retry` returns a task the loop itself put into `blocked` —
// expected, low-stakes, no confirmation needed. Reopening a `complete`
// task undoes a task the loop already verified and committed, and can
// invalidate everything built against it since, which is why the CLI
// requires an explicit `--confirm` before calling this — see
// `reopenCommand`.
//
// A downstream task not yet `complete` (still `planned`, `ready`,
// `building`, `blocked`) is left exactly where it is: it hasn't shipped
// anything for the fix to invalidate, and its own lease (if any) is not
// this command's to touch. Only `complete` tasks — upstream's own status
// plus every `complete` descendant — move; anything else downstream is
// reported back so the caller can decide what to do about in-flight
// work sitting on top of a reopened dependency.
export function reopenTask(db, taskId) {
  return inTransaction(db, () => {
    reapExpiredLeases(db);
    const task = loadTask(db, taskId);
    if (task === undefined) return { reopened: false, reason: 'no_such_task' };
    if (task.status !== 'complete') {
      return { reopened: false, reason: 'not_complete', task };
    }

    const downstreamIds = loadTransitiveDependents(db, taskId);
    const downstreamTasks = downstreamIds.map((id) => loadTask(db, id));
    const toReopen = [task, ...downstreamTasks.filter((t) => t.status === 'complete')];
    const stillInFlight = downstreamTasks.filter((t) => t.status !== 'complete');

    const reopenOne = db.prepare(
      `
      UPDATE tasks SET status = 'planned', blocked_reason = NULL,
        lease_owner = NULL, lease_expires_at = NULL, leased_at = NULL,
        claim_snapshot = NULL
      WHERE id = ? AND status = 'complete'
      RETURNING id
    `,
    );
    const reopenedIds = [];
    for (const t of toReopen) {
      const result = reopenOne.get(t.id);
      if (result !== undefined) reopenedIds.push(result.id);
    }

    return {
      reopened: true,
      reopenedIds,
      stillInFlight,
      task: loadTask(db, taskId),
    };
  });
}

// Releases `taskId` back to `ready` if `owner` currently holds its lease.
// Scoped to `status = 'building'` — `verifying` is the engine's own
// transient lease during verifyTask, not something an external release
// call should touch. Unlike lease expiry (a dead-agent scenario that goes
// to `blocked`), an explicit release is a live agent saying "I'm done
// with this, not because it's broken" — so the task is immediately
// re-claimable.
export function releaseTask(db, taskId, owner) {
  return inTransaction(db, () => {
    const result = db
      .prepare(
        `
        UPDATE tasks SET status = 'ready', lease_owner = NULL,
          lease_expires_at = NULL, leased_at = NULL, claim_snapshot = NULL
        WHERE id = ? AND lease_owner = ? AND status = 'building'
        RETURNING id
      `,
      )
      .get(taskId, owner);

    if (result !== undefined) return { released: true };
    // Which of the two failures this was, so the CLI can say "no such
    // task" instead of implying the id exists but is held by someone
    // else — a mistyped id and a genuinely un-held task are different
    // problems with different fixes.
    const task = loadTask(db, taskId);
    return { released: false, reason: task === undefined ? 'no_such_task' : 'not_held', task };
  });
}

// Extends `taskId`'s lease by `minutes` if `owner` currently holds it,
// during either `building` or `verifying`.
export function renewLease(db, taskId, owner, minutes) {
  return inTransaction(db, () => {
    const result = db
      .prepare(
        `
        UPDATE tasks SET lease_expires_at = datetime('now', '+' || ? || ' minutes')
        WHERE id = ? AND lease_owner = ? AND status IN ('building', 'verifying')
        RETURNING id
      `,
      )
      .get(minutes, taskId, owner);

    if (result !== undefined) return { renewed: true };
    const task = loadTask(db, taskId);
    return { renewed: false, reason: task === undefined ? 'no_such_task' : 'not_held', task };
  });
}
