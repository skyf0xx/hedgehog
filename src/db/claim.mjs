// `hedgehog claim` / `release` / `renew` — lease-based task assignment.
// See hedgehog-persistent-build-graph.md, "Claims", and the lease/claim
// columns added to `tasks` in schema.mjs.

import { inTransaction } from './init.mjs';
import { conflicts } from './conflict.mjs';

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

    return { released: result !== undefined };
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

    return { renewed: result !== undefined };
  });
}
