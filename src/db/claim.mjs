// `hedgehog claim` / `release` / `renew` — lease-based task assignment.
// See hedgehog-persistent-build-graph.md, "Claims", and the lease/claim
// columns added to `tasks` in schema.mjs.

import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { inTransaction } from './init.mjs';
import { conflicts } from './conflict.mjs';
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
        lease_owner = NULL, lease_expires_at = NULL, leased_at = NULL,
        claim_snapshot = NULL
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
      lease_expires_at = datetime('now', '+' || ? || ' minutes'),
      claim_snapshot = ?
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
  ensureTaskColumns(db);
  // Read the working tree *before* BEGIN — this file keeps verify.mjs's
  // rule that no subprocess runs with a sqlite transaction open. One
  // snapshot serves the whole batch: they all start from the same tree.
  // Taking it a moment early can only miss a path dirtied in between,
  // which leaves that path attributed — the strict direction.
  const claimSnapshot = snapshotWorkingTree();

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
      const result = runClaim.get(owner, leaseMinutes, claimSnapshot, candidate.id);
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
          lease_expires_at = NULL, leased_at = NULL, claim_snapshot = NULL
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
