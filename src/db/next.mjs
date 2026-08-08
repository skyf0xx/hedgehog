// `hedgehog next` — readiness query + task-packet assembly for one task.
// See hedgehog-persistent-build-graph.md, the readiness `SELECT` under
// "Schema", and "The task packet" / the `hedgehog next` output example.
//
// Readiness: a task with no dependency whose status isn't `complete`,
// lowest `priority` then `id`. Pickable status is `planned` OR `ready` —
// `plan.mjs` inserts new tasks as `planned`, but `verify.mjs`'s
// unlockReadyDependents sets a dependent's status to `ready` directly
// once its dependencies complete (see verify.mjs), without ever passing
// back through `planned`. A task already marked `ready` still has to
// satisfy the same no-incomplete-dependency condition here — the OR
// widens which statuses are eligible, it doesn't relax the dependency
// check itself. Once found, the packet is assembled by querying tasks
// joined through intents/requirements/task_requirements — never
// hand-written, never the whole plan.

import { CORE_MODULE } from './plan.mjs';

const READY_TASK_SQL = `
  SELECT t.* FROM tasks t
  WHERE t.status IN ('planned', 'ready')
    AND t.lease_owner IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM dependencies d
      JOIN tasks dep ON dep.id = d.depends_on_task_id
      WHERE d.task_id = t.id AND dep.status <> 'complete'
    )
  ORDER BY t.priority, t.id
  LIMIT 1;
`;

function findReadyTask(db) {
  return db.prepare(READY_TASK_SQL).get();
}

function loadIntent(db, intentId) {
  return db.prepare('SELECT * FROM intents WHERE id = ?').get(intentId);
}

function loadTaskRequirements(db, taskId) {
  return db
    .prepare(
      `
      SELECT r.* FROM requirements r
      JOIN task_requirements tr ON tr.requirement_id = r.id
      WHERE tr.task_id = ?
    `,
    )
    .all(taskId);
}

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

// The full transitive closure of tasks blocked on `taskId`, not just its
// direct dependents (spec example: BLOCKED DOWNSTREAM lists the ready
// task's entire remaining chain — contract, repository, service, screen —
// not only the one task directly depending on it). Walked breadth-first,
// de-duplicated, in dependency order.
function loadBlockedDownstream(db, taskId) {
  const seen = new Set([taskId]);
  const result = [];
  let frontier = [taskId];
  while (frontier.length > 0) {
    const next = [];
    for (const id of frontier) {
      for (const dep of loadDirectDependents(db, id)) {
        if (seen.has(dep.id)) continue;
        seen.add(dep.id);
        result.push(dep);
        next.push(dep.id);
      }
    }
    frontier = next;
  }
  return result;
}

// Assembles the packet for `task` (already known ready) by querying its
// intent, requirements, and blocked downstream chain. Returns null fields
// never — every field here is NOT NULL on tasks, or defaults to an empty
// list.
function assemblePacket(db, task) {
  const intent = loadIntent(db, task.intent_id);
  const requirements = loadTaskRequirements(db, task.id);
  const dependents = loadBlockedDownstream(db, task.id);

  return {
    task,
    intent,
    requirements,
    dependents,
  };
}

// Returns the assembled packet for the one ready task (spec: readiness
// SELECT), or null if no task is ready.
export function nextTask(db) {
  const task = findReadyTask(db);
  if (!task) return null;
  return assemblePacket(db, task);
}

// Tasks stalled awaiting a fix: `blocked` (verification failed, a scope
// violation refused to run it, or a lease expired mid-build — see
// blocked_reason). Not pickable by the readiness query, so when
// `nextTask` returns null the caller uses this to tell "the build is
// finished" apart from "the build is stuck on a task that needs fixing"
// — otherwise a blocked task makes the graph look complete.
export function stalledTasks(db) {
  return db
    .prepare(
      `
      SELECT t.* FROM tasks t
      WHERE t.status = 'blocked'
      ORDER BY t.priority, t.id
    `,
    )
    .all();
}

// Renders a packet into the STATUS / INTENT / RELEVANT RULES / WHY NOW /
// BLOCKED DOWNSTREAM / ALLOWED SCOPE / VERIFICATION format. The spec
// splits this across two examples — the `hedgehog next` display and "The
// task packet" (which carries the intent and its rules) — but an agent
// receives one thing, so the packet is one thing: everything the worker
// needs to build the task without reading the plan.
export function formatNext(packet) {
  const { task, intent, requirements, dependents } = packet;
  const scopeGlobs = JSON.parse(task.scope_globs);

  const lines = [];
  lines.push(`TASK  ${task.id}`);
  lines.push(task.objective);
  lines.push('');
  lines.push('STATUS   READY');
  lines.push('');
  lines.push('INTENT');
  lines.push(`  ${intent.goal}`);
  lines.push(`  ${intent.outcome}`);
  lines.push('');
  lines.push('RELEVANT RULES');
  if (requirements.length === 0) {
    lines.push('  (none recorded)');
  } else {
    for (const req of requirements) {
      lines.push(`  - ${req.statement}`);
    }
  }
  lines.push('');
  lines.push('WHY NOW');
  lines.push(`  ✓ Intent "${intent.id}" compiled into the graph`);
  // A once: true layer has no module — it compiled one task for the whole
  // build (plan.mjs, CORE_MODULE), so naming a domain module here would
  // print the compiler's internal placeholder as if it were one.
  if (task.module === CORE_MODULE) {
    lines.push('  ✓ Cross-cutting layer — one task for the whole build');
  } else {
    lines.push(`  ✓ Domain module "${task.module}" resolved`);
  }
  lines.push('  ✓ No incomplete dependencies');
  lines.push('');
  lines.push('BLOCKED DOWNSTREAM');
  if (dependents.length === 0) {
    lines.push('  (none)');
  } else {
    for (const dep of dependents) {
      lines.push(`  ✗ ${dep.id}   ${dep.layer}`);
    }
  }
  lines.push('');
  lines.push('ALLOWED SCOPE');
  for (const glob of scopeGlobs) lines.push(`  ${glob}`);
  lines.push('');
  lines.push('VERIFICATION');
  lines.push(`  ${task.verify_command}`);

  return lines.join('\n');
}
