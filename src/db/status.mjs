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

import { radiusGaps } from './code-intelligence.mjs';
import { listDebt } from './debt.mjs';
import { detectDrift, formatDrift } from './drift.mjs';
import { frictionByModule, listFriction } from './friction.mjs';
import { orphanedOverrides } from './overrides.mjs';
import { formatMissingRequirements } from './requires.mjs';
import { readyTasks, heldBackReason } from './ready.mjs';

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

// Collapses every debt row to one entry per declaring task: { taskId, n }
// in task-id order. The notes themselves stay out — a status overview
// that reprints them is `debt list` with extra steps, and the note only
// becomes actionable in the packet of a task that inherits it, where
// next.mjs already renders it in full. The task id is the part that has
// to be here, because it is the argument `debt list <task>` needs and
// the thing an operator has no other way to guess.
function loadDebtByTask(db) {
  const byTask = new Map();
  for (const { taskId } of listDebt(db)) {
    byTask.set(taskId, (byTask.get(taskId) ?? 0) + 1);
  }
  return [...byTask.entries()]
    .map(([taskId, n]) => ({ taskId, n }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
}

// Advisory radius suggestions: for every task whose context was resolved
// against a code-intelligence index (context_files non-NULL), the files
// its computed blast radius reaches that no verify_radius/scope_globs
// glob covers (code-intelligence.mjs#radiusGaps). Skips every task with
// no resolved context outright, which is what a task planned without a
// working index leaves behind — the same NULL a broken or removed CGC
// install produces, not a state `status` distinguishes from an
// intentionally unindexed run.
//
// Wrapped the way countFriction is: `status` reads through a read-only
// handle, which never migrates, so on a graph predating the context
// columns this SELECT throws on a column that isn't there yet. An
// unmigrated graph reads as no suggestions, not as a failed `status`.
function loadRadiusSuggestions(db) {
  try {
    const tasks = db.prepare('SELECT * FROM tasks WHERE context_files IS NOT NULL').all();
    const suggestions = [];
    for (const task of tasks) {
      const gaps = radiusGaps(task);
      if (gaps.length > 0) suggestions.push({ taskId: task.id, files: gaps });
    }
    return suggestions;
  } catch {
    return [];
  }
}

// The friction row count, or 0. `listFriction` reads the table
// unguarded, so a build graph predating it throws here where `listDebt`
// would return [] — caught rather than propagated for the same reason
// the CLI tolerates an unparseable core.yaml: status is the command
// every session starts with, and one absent table must not cost the
// operator the whole overview. Every other section is still true.
function countFriction(db) {
  try {
    return listFriction(db).length;
  } catch {
    return 0;
  }
}

// Returns { counts, ready, heldBack, inFlight, attention, drift,
// orphanedOverrides, debt, frictionCount, frictionHotspots,
// radiusSuggestions, total } —
// counts keyed by every status in the tasks CHECK constraint (present
// even at zero), ready the full list of currently-pickable tasks,
// heldBack the subset of those that `hedgehog claim` would skip over
// right now because they conflict with in-flight work or another ready
// task ahead of them
// (ready.mjs's own simulation, reused rather than reimplemented —
// without this a task can sit in READY indefinitely with no visible
// reason, the same invisible-stall shape blocked tasks had before
// `attention` existed), inFlight the tasks currently leased (building or
// verifying), attention the stalled tasks needing a fix, total the sum
// across all statuses.
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
//
// `orphanedOverrides` (overrides.mjs) is the override ids matching no
// task row. It rides on `status` rather than on `override list` alone
// because a dead override is invisible by construction — composeScope
// missing a key is a no-op, so the file widens nothing and raises
// nothing, and `override list` is a command an operator only runs once
// they already suspect something. It reads only `tasks`, not core.yaml,
// so it is computed unconditionally: an override id is stale or it
// isn't, whether or not a core definition is loadable.
//
// `debt` (per declaring task) and `frictionCount` are counts, not
// listings: both tables are append-only with no resolved column, so
// there is no "open" subset to filter to and this can only ever report
// what has been declared. That is the honest reading and also the
// useful one — a debt note is consumed by whichever downstream task
// inherits it, and friction is reviewed in a batch by tweaker, so
// neither is a queue `status` could burn down. What was missing was
// only the existence signal: `debt list` needs a task id the operator
// has no way to guess, and `friction list` needs the operator to
// already suspect there is something to read.
//
// `frictionHotspots` (friction.mjs#frictionByModule) is the one reading
// of friction that isn't a count: the files the friction-carrying tasks
// reach, ranked. It rides along here because it is a read of `friction`
// joined to `tasks` and needs nothing else passed in. On a project whose
// tasks carry no resolved context it is an empty hotspot list and a full
// `uncorrelated` count, which is the same signal `frictionCount` alone
// already gave.
//
// `radiusSuggestions` (code-intelligence.mjs#radiusGaps) is advisory,
// never enforcement: files a task's computed blast radius reaches that
// its declared verify_radius/scope_globs doesn't cover. Computed only
// for tasks with a resolved context_files, same gate as the hotspots
// read — a project with no index attached contributes nothing here.
export function graphStatus(db, { core = null, overrides = new Map() } = {}) {
  const counts = countTasksByStatus(db);
  const ready = loadReadyTasks(db);
  const { heldBack } = readyTasks(db);
  const inFlight = loadInFlightTasks(db);
  const attention = loadAttentionTasks(db);
  const drift = core ? detectDrift(db, core, { overrides }) : [];
  const orphaned = orphanedOverrides(db, overrides);
  const debt = loadDebtByTask(db);
  const frictionCount = countFriction(db);
  const frictionHotspots = frictionByModule(db);
  const radiusSuggestions = loadRadiusSuggestions(db);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    counts,
    ready,
    heldBack,
    inFlight,
    attention,
    drift,
    orphanedOverrides: orphaned,
    debt,
    frictionCount,
    frictionHotspots,
    radiusSuggestions,
    total,
  };
}

const BLOCKED_REASON_LABELS = {
  verification_failed: 'verification failed',
  scope_violation: 'scope violation',
  lease_expired: 'lease expired',
};

// Renders a graphStatus() result into a plain-text overview: counts by
// status (only non-zero ones, in lifecycle order), any declared binary
// this environment can't resolve, the ready list, tasks currently in
// flight, anything needing attention, core.yaml drift, overrides
// pointing at no task, and what has been recorded in the two
// append-only side channels (declared debt, logged friction).
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
  heldBack = [],
  inFlight,
  attention,
  drift,
  orphanedOverrides = [],
  debt = [],
  frictionCount = 0,
  frictionHotspots = { hotspots: [], uncorrelated: 0 },
  radiusSuggestions = [],
  total,
  missingRequirements,
  // Rendered lines from formatIndexStaleness, or [] when the index is
  // fresh or absent. Passed in rather than computed: this module reads
  // the graph, and index provenance lives on disk and in git, which is
  // the CLI's side of the line.
  indexStaleness = [],
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
  // Each ready task is annotated inline with why `hedgehog claim` would
  // skip it right now, rather than listed flatly — a task can otherwise
  // sit in READY indefinitely with no visible reason (see graphStatus).
  const heldBackById = new Map(heldBack.map(({ task, conflict }) => [task.id, conflict]));
  lines.push('READY');
  if (ready.length === 0) {
    lines.push('  (none)');
  } else {
    for (const task of ready) {
      const conflict = heldBackById.get(task.id);
      const note = conflict ? `   (held back — ${heldBackReason(task, conflict)})` : '';
      lines.push(`  ${task.id}   ${task.layer}   ${task.objective}${note}`);
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

  // These three, because each is a condition of the graph as a whole
  // rather than of any one task, and because an operator reading top-down
  // should reach them after knowing what's ready and what's stuck.
  if (drift && drift.length > 0) {
    lines.push('');
    lines.push(formatDrift(drift));
  }

  // Below drift because it's the rarer of the two and never blocks the
  // build: an orphaned override is work the operator asked for that isn't
  // happening, not work the graph is getting wrong. `hedgehog override
  // list` carries the full explanation of how an id goes stale; here the
  // consequence is the whole point, since this is the only place an
  // operator who doesn't already suspect it will ever see it.
  if (orphanedOverrides.length > 0) {
    lines.push('');
    lines.push('ORPHANED OVERRIDES');
    for (const taskId of orphanedOverrides) {
      lines.push(`  ${taskId}   no task with this id in the build graph`);
    }
    lines.push('');
    lines.push('  Each widens nothing until the id matches a real task. See: hedgehog override list');
  }

  // Advisory, never a defect count: verify_radius/scope_globs is what
  // actually gates `hedgehog verify`, and stays the sole authority on
  // that whether or not this prints. This only names what a
  // code-intelligence index thinks a task's blast radius reaches beyond
  // its declared radius — a widening the operator may or may not want.
  if (radiusSuggestions.length > 0) {
    lines.push('');
    lines.push('RADIUS SUGGESTIONS');
    for (const { taskId, files } of radiusSuggestions) {
      lines.push(`  ${taskId}   verify_radius may be missing:`);
      for (const file of files) lines.push(`    ${file}`);
    }
    lines.push('');
    lines.push(
      indexStaleness.length > 0
        ? '  Sourced from a code-intelligence index that is out of date (below). Widen with: hedgehog plan --recompile'
        : '  Sourced from a code-intelligence index. Widen with: hedgehog plan --recompile',
    );
  }

  // Below the suggestions it qualifies, and printed whether or not any
  // were raised: an index that has drifted from HEAD also under-reports,
  // so an empty RADIUS SUGGESTIONS section is exactly when a reader most
  // needs to know the index is stale rather than the code clean.
  if (indexStaleness.length > 0) {
    lines.push('');
    lines.push(...indexStaleness);
  }

  // Bottom, below every condition above, and two sections rather than
  // one. Everything above is something wrong — work stalled, a graph
  // that disagrees with its core, an override doing nothing. These two
  // are neither wrong nor actionable here: both tables are append-only,
  // so nothing printed can be cleared by acting on it, and an operator
  // scanning top-down should hit what needs a decision first.
  //
  // Kept apart because they are read by different people at different
  // times through different commands. Debt is in-build traffic between
  // two tasks — it arrives on its own in the inheriting task's packet,
  // and naming the declaring tasks here is only so `debt list <task>`
  // is reachable without guessing the id. Friction is about Hedgehog
  // itself, batch-reviewed by tweaker at the end of a build, and has no
  // per-task reading at all (a row's task_id is nullable). Merging them
  // into one "notes" count would imply a single follow-up action where
  // there are two unrelated ones.
  if (debt.length > 0) {
    const rows = debt.reduce((sum, { n }) => sum + n, 0);
    lines.push('');
    lines.push(`DECLARED DEBT  ${rows}`);
    for (const { taskId, n } of debt) {
      lines.push(`  ${taskId}   ${n} note${n === 1 ? '' : 's'}`);
    }
    lines.push('');
    lines.push('  Reaches each dependent task\'s packet on its own. See: hedgehog debt list <task-id>');
  }

  if (frictionCount > 0) {
    lines.push('');
    lines.push(`FRICTION LOGGED  ${frictionCount}`);
    // The top three only: this is a lead for tweaker's grouping pass, not
    // a listing, and a ranked tail nobody acts on costs the whole block
    // its readability. The uncorrelated count prints whenever it's
    // non-zero — including with no hotspots at all, which is how a
    // project whose tasks carry no resolved context reads.
    const { hotspots = [], uncorrelated = 0 } = frictionHotspots ?? {};
    if (hotspots.length > 0 || uncorrelated > 0) {
      lines.push('');
      for (const { path, frictionCount: n } of hotspots.slice(0, 3)) {
        lines.push(`  ${path}   ${n} note${n === 1 ? '' : 's'}`);
      }
      if (uncorrelated > 0) {
        lines.push(`  ${uncorrelated} note${uncorrelated === 1 ? '' : 's'} not correlated to any file`);
      }
    }
    lines.push('');
    lines.push('  Reviewed as a batch at the end of a build. See: hedgehog friction list');
  }

  return lines.join('\n');
}
