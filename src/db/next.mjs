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
  ORDER BY t.priority, t.exclusive DESC, t.id
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

// The full transitive closure of tasks this one depends on — its whole
// upstream chain, not just its direct dependencies. Debt declared three
// layers up doesn't stop applying one layer later, so the packet has to
// see the same distance the dependency edge actually reaches.
function loadUpstreamTaskIds(db, taskId) {
  const directDeps = db.prepare(
    'SELECT depends_on_task_id AS id FROM dependencies WHERE task_id = ?',
  );
  const seen = new Set([taskId]);
  const upstream = [];
  let frontier = [taskId];
  while (frontier.length > 0) {
    const next = [];
    for (const id of frontier) {
      for (const row of directDeps.all(id)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        upstream.push(row.id);
        next.push(row.id);
      }
    }
    frontier = next;
  }
  return upstream;
}

// Debt declared by anything this task inherits from (see debt.mjs).
// Tolerates a `debt` table that doesn't exist yet — a build graph created
// before the table was added must still be able to emit a packet.
function loadInheritedDebt(db, taskId) {
  const upstream = loadUpstreamTaskIds(db, taskId);
  if (upstream.length === 0) return [];
  const placeholders = upstream.map(() => '?').join(',');
  try {
    return db
      .prepare(
        `SELECT task_id AS taskId, note FROM debt WHERE task_id IN (${placeholders}) ORDER BY id ASC`,
      )
      .all(...upstream);
  } catch {
    return [];
  }
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
  const inheritedDebt = loadInheritedDebt(db, task.id);

  return {
    task,
    intent,
    requirements,
    dependents,
    incompleteDeps,
    inheritedDebt,
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

// full-stack-app's own layer → Nx tag shape, mirroring the tag reference
// table `src/golden-cores/full-stack-app/packages/config/eslint-base.js`
// ships as a comment. A layer's `depConstraints` failure is a mechanical
// consequence of this table crossed with `core.yaml`'s `depends_on` chain
// — printing it in the packet turns that failure into a pre-flight fact
// instead of something `nx lint` teaches the agent after the fact. Keyed
// by layer id, not module, since the shape is the same for every module.
const FULL_STACK_APP_LAYER_TAGS = {
  schema: { tags: ['scope:db', 'type:adapter'], dependsOnTags: [] },
  contract: { tags: ['scope:contracts', 'type:contract'], dependsOnTags: ['type:adapter', 'type:util'] },
  repository: { tags: ['scope:{module}', 'type:adapter'], dependsOnTags: ['type:adapter', 'type:contract', 'type:util'] },
  service: { tags: ['scope:{module}', 'type:service'], dependsOnTags: ['type:adapter', 'type:contract', 'type:util'] },
  controller: { tags: ['scope:api'], dependsOnTags: ['type:adapter', 'type:service', 'type:contract', 'type:util'] },
  hook: { tags: ['scope:hooks', 'type:hook'], dependsOnTags: ['type:contract', 'type:util'] },
  screen: { tags: ['scope:web'], dependsOnTags: ['scope:contracts', 'scope:hooks', 'scope:shared', 'type:util'] },
};

// A LAYER SHAPE section for full-stack-app tasks only (`coreId ===
// 'full-stack-app'`) — an authored core has no equivalent tag scheme
// (layer-eng.md already points that agent at reading .hedgehog/core.yaml
// directly instead), and `join` has no fixed tag shape of its own to
// state, so both fall through to null and print nothing.
function layerShapeLines(task, coreId) {
  if (coreId !== 'full-stack-app') return null;
  const shape = FULL_STACK_APP_LAYER_TAGS[task.layer];
  if (!shape) return null;
  const tags = shape.tags.map((t) => t.replace('{module}', task.module));
  const lines = ['LAYER SHAPE', `  this layer's tags:      ${tags.join(', ')}`];
  if (shape.dependsOnTags.length === 0) {
    lines.push('  may depend on tags:     (nothing in-workspace — floor layer)');
  } else {
    lines.push(`  may depend on tags:     ${shape.dependsOnTags.join(', ')}`);
  }
  lines.push(
    "  Confirm against packages/config/eslint-base.js's depConstraints before",
    "  writing an import — a mismatch here is a pre-flight fact, not a lint",
    '  failure to discover later.',
  );
  return lines;
}

// The standing honesty requirement, appended to every packet.
//
// Every other section is task-specific — this one is constant, which is
// exactly why it lives in the renderer rather than in the graph. The
// build's mechanical gate can only ask "did the verify command exit 0",
// so a layer that stubs a dependency permissively, returns 0 where it
// meant "unknown", or invents a decision the requirements never made
// passes the gate and fails later, somewhere else. The defensive
// behaviour that catches those — a stub that throws by name, a value
// surfaced as unavailable, an undecided question reported instead of
// answered — only ever happened when a human wrote the instruction into
// the dispatch by hand. Generating it into the packet makes it standing
// rather than remembered.
//
// Kept to ten lines on purpose: an agent reads this on every task, and
// a section long enough to skim is a section that isn't read.
const HONESTY = [
  'HONESTY',
  "  Build what this layer can; make what it can't obvious.",
  '  - A stub or placeholder throws a named error at first use — never',
  '    returns empty, null, or success from something unbuilt.',
  '  - A value that cannot be computed is surfaced as unavailable — never',
  '    replaced by 0, "", or a plausible default.',
  "  - A decision RELEVANT RULES doesn't make is reported, not invented.",
  '  - A scope that turns out to be wrong is reported, not widened.',
  '  Reporting one of these is a successful outcome. Papering over it is',
  '  the failure VERIFICATION cannot catch.',
];

// Renders a packet into the STATUS / INTENT / RELEVANT RULES /
// INHERITED DEBT / WHY NOW / BLOCKED DOWNSTREAM / ALLOWED SCOPE / LAYER
// SHAPE / VERIFICATION / HONESTY format. The spec
// splits this across two examples — the `hedgehog next` display and "The
// task packet" (which carries the intent and its rules) — but an agent
// receives one thing, so the packet is one thing: everything the worker
// needs to build the task without reading the plan.
//
// `statusLine` is what goes on the STATUS row. `next` passes READY
// literally, as it always has; `show` passes taskStatusLine(task), which
// names the task's real state. `coreId` is the active core's `id` (from
// `core.yaml`) — optional, since a caller with no core resolved yet (a
// deferred install) still has to be able to render *something*; LAYER
// SHAPE only ever appears for a recognised full-stack-app layer.
//
// HONESTY is last deliberately: it's the one section that qualifies the
// gate above it, so it reads as the answer to "and what if I can't clear
// VERIFICATION honestly" rather than as preamble.
export function formatPacket(packet, statusLine, coreId = null) {
  const { task, intent, requirements, dependents, incompleteDeps = [], inheritedDebt = [] } = packet;
  const scopeGlobs = JSON.parse(task.scope_globs);

  const lines = [];
  lines.push(`TASK  ${task.id}`);
  lines.push(task.objective);
  lines.push('');
  lines.push(`STATUS   ${statusLine}`);
  lines.push('');
  // The intent's goal and outcome are what this task's layer is a part
  // of — labelled rather than left as two bare lines, because the
  // layer's own `objective` ("domain-service for card") says what to
  // build a layer of, and only these say what the work is *for*. A layer
  // can otherwise pass its own verify green while covering half of what
  // the intent asked for.
  lines.push('INTENT');
  lines.push(`  GOAL     ${intent.goal}`);
  lines.push(`  OUTCOME  ${intent.outcome}`);
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
  lines.push('INHERITED DEBT');
  if (inheritedDebt.length === 0) {
    lines.push('  (none declared)');
  } else {
    for (const entry of inheritedDebt) {
      lines.push(`  ! ${entry.taskId}  ${entry.note}`);
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
  const shapeLines = layerShapeLines(task, coreId);
  if (shapeLines) {
    lines.push(...shapeLines);
    lines.push('');
  }
  lines.push('VERIFICATION');
  lines.push(`  ${task.verify_command}`);
  lines.push('');
  lines.push(...HONESTY);

  return lines.join('\n');
}

// `hedgehog next`'s rendering: its task always came out of the readiness
// SELECT, so STATUS is READY by construction.
export function formatNext(packet, coreId = null) {
  return formatPacket(packet, 'READY', coreId);
}
