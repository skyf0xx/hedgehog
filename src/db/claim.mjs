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

import { inTransaction } from './init.mjs';
import { conflicts } from './conflict.mjs';
import { incompleteDependencies } from './next.mjs';

// Same no-incomplete-dependency shape as next.mjs's READY_TASK_SQL, without
// the LIMIT 1 — claimTasks may take more than one candidate per call.
const CLAIMABLE_TASKS_SQL = `
  SELECT t.* FROM tasks t
  WHERE t.status IN ('planned', 'ready')
    AND t.lease_owner IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM dependencies d
      JOIN tasks dep ON dep.id = d.depends_on_task_id
      WHERE d.task_id = t.id AND dep.status <> 'complete'
    )
  ORDER BY t.priority, t.id
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
export function reapExpiredLeases(db) {
  db.prepare(
    `
    UPDATE tasks
    SET status = 'blocked', blocked_reason = 'lease_expired',
        lease_owner = NULL, lease_expires_at = NULL, leased_at = NULL
    WHERE status IN ('building', 'verifying') AND lease_expires_at < datetime('now')
  `,
  ).run();
}

// The atomic claim primitive: the WHERE clause re-checks status and
// lease_owner at UPDATE time, so RETURNING a row (rather than undefined)
// is the only proof this call won the race against a concurrent claim.
const claimOne = (db) =>
  db.prepare(`
    UPDATE tasks SET status = 'building', lease_owner = ?, leased_at = datetime('now'),
      lease_expires_at = datetime('now', '+' || ? || ' minutes')
    WHERE id = ? AND status IN ('planned','ready') AND lease_owner IS NULL
    RETURNING id
  `);

// Claims up to `count` ready tasks for `owner`. `count` is a maximum, not
// a promise — returns however many were actually claimed, possibly zero.
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
  return inTransaction(db, () => {
    reapExpiredLeases(db);

    const candidates = findClaimableTasks(db);
    const inFlight = findInFlightTasks(db);
    const runClaim = claimOne(db);
    const claimed = [];

    for (const candidate of candidates) {
      if (claimed.length >= count) break;
      const against = [...inFlight, ...claimed];
      if (against.some((accepted) => conflicts(candidate, accepted) !== null)) continue;
      const result = runClaim.get(owner, leaseMinutes, candidate.id);
      if (result === undefined) continue; // lost the race, skip
      claimed.push(loadTask(db, candidate.id));
    }

    return claimed;
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

    const result = claimOne(db).get(owner, leaseMinutes, task.id);
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
          lease_expires_at = NULL, leased_at = NULL
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
