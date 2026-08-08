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

// The dependencies of `taskId` that aren't `complete` yet — the negation
// of the readiness SELECT's NOT EXISTS clause, returned as rows rather
// than a boolean. `next` never sees a non-empty list (its candidate set
// is exactly the tasks with none), but `show` renders packets for tasks
// at any point in the lifecycle, and claim.mjs's targeted claim has to
// name what a specific task is still waiting on rather than refusing
// with no reason.
export function incompleteDependencies(db, taskId) {
  return db
    .prepare(
      `
      SELECT dep.* FROM dependencies d
      JOIN tasks dep ON dep.id = d.depends_on_task_id
      WHERE d.task_id = ? AND dep.status <> 'complete'
      ORDER BY dep.priority, dep.id
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

// Assembles the packet for `task` by querying its intent, requirements,
// blocked downstream chain, and any dependency not yet complete. Returns
// null fields never — every field here is NOT NULL on tasks, or defaults
// to an empty list. `incompleteDeps` is always empty for a task the
// readiness SELECT picked; it's non-empty only for packets assembled by
// `taskPacket` for a task that isn't ready.
function assemblePacket(db, task) {
  const intent = loadIntent(db, task.intent_id);
  const requirements = loadTaskRequirements(db, task.id);
  const dependents = loadBlockedDownstream(db, task.id);
  const incompleteDeps = incompleteDependencies(db, task.id);

  return {
    task,
    intent,
    requirements,
    dependents,
    incompleteDeps,
  };
}

// Returns the assembled packet for the one ready task (spec: readiness
// SELECT), or null if no task is ready.
export function nextTask(db) {
  const task = findReadyTask(db);
  if (!task) return null;
  return assemblePacket(db, task);
}

// The same packet for a task named by id, at any point in its lifecycle
// — the read `next` can't perform once a task leaves the readiness
// SELECT's candidate set. Claiming a task moves it to `building`, which
// makes it invisible to `next` (status not in planned/ready, lease_owner
// not null), so without this the packet an agent is supposed to work
// from becomes unreachable through the CLI the moment it is handed out.
// Returns null when no such task exists.
export function taskPacket(db, taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
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

const BLOCKED_REASON_LABELS = {
  verification_failed: 'verification failed',
  scope_violation: 'scope violation',
  lease_expired: 'lease expired',
};

// The STATUS line for a packet rendered outside the readiness query —
// `next` always prints READY (its candidate set guarantees it), but a
// packet for an already-claimed or blocked task has to say so, including
// who holds the lease and until when, since that's what an operator
// needs to decide between verify, release, renew, and retry.
export function taskStatusLine(task) {
  if (task.status === 'building' || task.status === 'verifying') {
    return `${task.status.toUpperCase()}   leased to ${task.lease_owner}, expires ${task.lease_expires_at}`;
  }
  if (task.status === 'blocked') {
    const reason = BLOCKED_REASON_LABELS[task.blocked_reason] ?? task.blocked_reason;
    return `BLOCKED   ${reason} — return it to the queue with: hedgehog retry ${task.id}`;
  }
  return task.status.toUpperCase();
}

// Renders a packet into the STATUS / INTENT / RELEVANT RULES / WHY NOW /
// BLOCKED DOWNSTREAM / ALLOWED SCOPE / VERIFICATION format. The spec
// splits this across two examples — the `hedgehog next` display and "The
// task packet" (which carries the intent and its rules) — but an agent
// receives one thing, so the packet is one thing: everything the worker
// needs to build the task without reading the plan.
//
// `statusLine` is what goes on the STATUS row. `next` passes READY
// literally, as it always has; `show` passes taskStatusLine(task), which
// names the task's real state.
export function formatPacket(packet, statusLine) {
  const { task, intent, requirements, dependents, incompleteDeps = [] } = packet;
  const scopeGlobs = JSON.parse(task.scope_globs);

  const lines = [];
  lines.push(`TASK  ${task.id}`);
  lines.push(task.objective);
  lines.push('');
  lines.push(`STATUS   ${statusLine}`);
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
  lines.push(`  ✓ Domain module "${task.module}" resolved`);
  if (incompleteDeps.length === 0) {
    lines.push('  ✓ No incomplete dependencies');
  } else {
    for (const dep of incompleteDeps) {
      lines.push(`  ✗ Waiting on ${dep.id}   ${dep.layer}   ${dep.status}`);
    }
  }
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

// `hedgehog next`'s rendering, unchanged: its task always came out of the
// readiness SELECT, so STATUS is READY by construction.
export function formatNext(packet) {
  return formatPacket(packet, 'READY');
}
