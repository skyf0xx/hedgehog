// `hedgehog status` — graph overview: task counts by status, and the
// current ready list. See hedgehog-persistent-build-graph.md, "Task
// lifecycle" for the status set and "The CLI is the only writer" for the
// `hedgehog status` line.
//
// The ready list reuses next.mjs's readiness query rather than
// reimplementing it: a task is pickable by `hedgehog next` when its
// status is `planned` or `ready` (plan.mjs inserts `planned`;
// verify.mjs's unlockReadyDependents sets `ready` directly) and it has
// no dependency whose status isn't `complete`. `hedgehog status` lists
// every task meeting that condition, not just the one `hedgehog next`
// would pick.

import { detectDrift, formatDrift } from './drift.mjs';
import { formatMissingRequirements } from './requires.mjs';

// The task lifecycle in order, matching the tasks CHECK constraint in
// schema.mjs exactly — every status the engine can write, and no others.
const TASK_STATUSES = [
  'proposed',
  'planned',
  'ready',
  'building',
  'verifying',
  'complete',
  'blocked',
];

// `exclusive DESC` matches claim.mjs's CLAIMABLE_TASKS_SQL and next.mjs's
// READY_TASK_SQL, so this list is in the order those two would actually
// take the work — see claim.mjs for why exclusive sorts first.
const READY_TASKS_SQL = `
  SELECT t.* FROM tasks t
  WHERE t.status IN ('planned', 'ready')
    AND t.lease_owner IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM dependencies d
      JOIN tasks dep ON dep.id = d.depends_on_task_id
      WHERE d.task_id = t.id AND dep.status <> 'complete'
    )
  ORDER BY t.priority, t.exclusive DESC, t.id;
`;

const IN_FLIGHT_TASKS_SQL = `
  SELECT t.* FROM tasks t
  WHERE t.status IN ('building', 'verifying')
  ORDER BY t.priority, t.id;
`;

function loadInFlightTasks(db) {
  return db.prepare(IN_FLIGHT_TASKS_SQL).all();
}

function countTasksByStatus(db) {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
    .all();
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0]));
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

function loadReadyTasks(db) {
  return db.prepare(READY_TASKS_SQL).all();
}

// Tasks that need a human/agent decision before the graph can move again
// — `blocked`, for any blocked_reason. Not pickable by `hedgehog next`,
// so without listing them here a build whose only remaining work is a
// blocked task looks identical to a finished one — "READY (none)" with
// no indication anything is wrong. Listing them is what makes the
// fix-then-`retry` path in hedgehog-loop's Loop step 4 discoverable
// from a fresh context.
const ATTENTION_TASKS_SQL = `
  SELECT t.* FROM tasks t
  WHERE t.status = 'blocked'
  ORDER BY t.priority, t.id;
`;

function loadAttentionTasks(db) {
  return db.prepare(ATTENTION_TASKS_SQL).all();
}

// Returns { counts, ready, inFlight, attention, drift, total } — counts
// keyed by every status in the tasks CHECK constraint (present even at
// zero), ready the full list of currently-pickable tasks, inFlight the
// tasks currently leased (building or verifying), attention the stalled
// tasks needing a fix, total the sum across all statuses.
//
// `core` is optional and, when given, adds `drift`: the tasks whose
// layer-derived fields no longer match core.yaml (drift.mjs). It's a
// parameter rather than a lookup because status.mjs has no business
// resolving the project's core path — the CLI already does that, and
// a project mid-install may not have a core definition at all.
//
// `overrides` (overrides.mjs#loadOverrides) is likewise the CLI's to
// resolve and pass in — detectDrift needs it composed against `core` or
// every task widened by `.hedgehog/overrides/*.json` reports permanent,
// spurious drift here.
export function graphStatus(db, { core = null, overrides = new Map() } = {}) {
  const counts = countTasksByStatus(db);
  const ready = loadReadyTasks(db);
  const inFlight = loadInFlightTasks(db);
  const attention = loadAttentionTasks(db);
  const drift = core ? detectDrift(db, core, { overrides }) : [];
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, ready, inFlight, attention, drift, total };
}

const BLOCKED_REASON_LABELS = {
  verification_failed: 'verification failed',
  scope_violation: 'scope violation',
  lease_expired: 'lease expired',
};

// Renders a graphStatus() result into a plain-text overview: counts by
// status (only non-zero ones, in lifecycle order), any declared binary
// this environment can't resolve, the ready list, tasks currently in
// flight, anything needing attention, and core.yaml drift.
//
// `missingRequirements` comes from the core definition rather than the
// database (src/db/requires.mjs#coreMissingRequirements), so the caller
// passes it in — status.mjs stays a pure function of the graph. It
// prints above READY, not at the bottom with NEEDS ATTENTION, because a
// missing binary invalidates everything below it: those tasks look
// perfectly ready and cannot possibly verify.
export function formatStatus({
  counts,
  ready,
  inFlight,
  attention,
  drift,
  total,
  missingRequirements,
}) {
  const lines = [];
  lines.push(`TASKS  ${total}`);
  lines.push('');
  for (const status of TASK_STATUSES) {
    if (counts[status] === 0) continue;
    lines.push(`  ${status.padEnd(12)} ${counts[status]}`);
  }
  lines.push('');
  const missingLines = formatMissingRequirements(missingRequirements);
  if (missingLines.length > 0) {
    lines.push(...missingLines);
    lines.push('');
  }
  lines.push('READY');
  if (ready.length === 0) {
    lines.push('  (none)');
  } else {
    for (const task of ready) {
      lines.push(`  ${task.id}   ${task.layer}   ${task.objective}`);
    }
  }

  if (inFlight && inFlight.length > 0) {
    lines.push('');
    lines.push('IN FLIGHT');
    for (const task of inFlight) {
      lines.push(`  ${task.id}   ${task.layer}   ${task.status}    owner: ${task.lease_owner}`);
    }
  }

  if (attention && attention.length > 0) {
    lines.push('');
    lines.push('NEEDS ATTENTION');
    for (const task of attention) {
      const reason = BLOCKED_REASON_LABELS[task.blocked_reason] ?? task.blocked_reason;
      lines.push(`  ${task.id}   ${task.layer}   ${reason}`);
    }
    lines.push('');
    // Not `verify` directly: a blocked task holds no lease, and verify
    // refuses anything that isn't `building` under the calling owner.
    // The way back in is retry (blocked → planned), then a claim.
    lines.push('  Fix the work, then: hedgehog retry <task-id> && hedgehog claim <task-id> --owner <owner>');
  }

  // Last, because it's a condition of the graph as a whole rather than
  // of any one task, and because an operator reading top-down should
  // reach it after knowing what's ready and what's stuck.
  if (drift && drift.length > 0) {
    lines.push('');
    lines.push(formatDrift(drift));
  }

  return lines.join('\n');
}
