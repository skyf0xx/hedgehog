// `hedgehog plan` — compiles pending intents against the project's core
// definition into `tasks` + `dependencies` rows. See
// hedgehog-persistent-build-graph.md, "The build graph" and "Task
// lifecycle", plus the readiness SELECT under "Schema".
//
// full-stack-app: one task per layer per intent (an intent is a domain
// module — see the core definition's `{module}` placeholder). landing-page:
// one task per phase, no module axis. Both are the same operation — walk
// a core definition's layer chain once per intent — because a linear
// chain is the degenerate case of the layer graph (spec: MVP scope
// item 5).

export function fillModule(template, module) {
  return template.replaceAll('{module}', module);
}

// Deterministic, human-legible task id: <INTENT>-<LAYER>, upper-cased.
// Stable across repeated `hedgehog plan` runs on the same intent/layer.
export function taskId(intentId, layerId) {
  return `${intentId}-${layerId}`.toUpperCase();
}

// The `tasks` columns whose value is derived purely from the core
// definition's layer (plus the module it's being instantiated for) —
// i.e. everything `plan` copies out of core.yaml and that a later
// core.yaml edit therefore leaves stale. Named once here so drift.mjs
// checks exactly the set layerTaskFields() writes, and the two can't
// silently diverge. `priority` is deliberately absent: it comes from the
// intent, not the layer.
export const LAYER_DERIVED_FIELDS = [
  'objective',
  'scope_globs',
  'verify_command',
  'commit_message',
  'exclusive',
  'verify_radius',
];

// The single definition of "what a layer contributes to a task row",
// shared by the compiler (below) and the drift check (drift.mjs).
export function layerTaskFields(layer, module) {
  return {
    objective: `${layer.id} for ${module}`,
    scope_globs: JSON.stringify(layer.scope.map((g) => fillModule(g, module))),
    verify_command: fillModule(layer.verify, module),
    commit_message: fillModule(layer.commit, module),
    exclusive: layer.exclusive ? 1 : 0,
    verify_radius:
      layer.verify_radius === null
        ? null
        : JSON.stringify(layer.verify_radius.map((g) => fillModule(g, module))),
  };
}

// Compiles one intent's tasks + intra-intent dependencies (mirroring the
// core definition's layer order) without touching the database.
function compileIntentTasks(intent, core) {
  const module = intent.id;
  const tasks = core.layers.map((layer) => ({
    id: taskId(intent.id, layer.id),
    intent_id: intent.id,
    module,
    layer: layer.id,
    priority: intent.priority,
    ...layerTaskFields(layer, module),
  }));

  const dependencies = [];
  for (const layer of core.layers) {
    if (!layer.depends_on) continue;
    dependencies.push({
      task_id: taskId(intent.id, layer.id),
      depends_on_task_id: taskId(intent.id, layer.depends_on),
    });
  }

  return { tasks, dependencies };
}

// Reads pending intents (status 'proposed' or 'planned' — not yet
// compiled into tasks) in dependency order: an intent is compiled only
// after every intent it depends_on. Intents with no ordering constraint
// between them compile in `priority, id` order.
function orderIntents(intents, intentDependencies) {
  const byId = new Map(intents.map((i) => [i.id, i]));
  const dependsOn = new Map(intents.map((i) => [i.id, []]));
  for (const { intent_id, depends_on_intent_id } of intentDependencies) {
    if (!dependsOn.has(intent_id)) continue;
    if (!byId.has(depends_on_intent_id)) continue;
    dependsOn.get(intent_id).push(depends_on_intent_id);
  }

  const ordered = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`intent_dependencies cycle detected at "${id}"`);
    }
    visiting.add(id);
    for (const depId of dependsOn.get(id) ?? []) visit(depId);
    visiting.delete(id);
    visited.add(id);
    ordered.push(byId.get(id));
  }

  const remaining = [...intents].sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
  );
  for (const intent of remaining) visit(intent.id);

  return ordered;
}

const PENDING_INTENT_STATUSES = ['proposed', 'planned'];

function loadPendingIntents(db) {
  const placeholders = PENDING_INTENT_STATUSES.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM intents WHERE status IN (${placeholders})`)
    .all(...PENDING_INTENT_STATUSES);
}

function loadIntentDependencies(db) {
  return db.prepare('SELECT * FROM intent_dependencies').all();
}

function loadIntentRequirements(db, intentId) {
  return db
    .prepare('SELECT id FROM requirements WHERE intent_id = ? ORDER BY id')
    .all(intentId);
}

function taskExists(db, taskId) {
  return db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId) !== undefined;
}

const insertTask = (db) =>
  db.prepare(`
    INSERT INTO tasks
      (id, intent_id, module, layer, objective, scope_globs, verify_command,
       commit_message, priority, exclusive, verify_radius, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')
  `);

const insertDependency = (db) =>
  db.prepare(`
    INSERT OR IGNORE INTO dependencies (task_id, depends_on_task_id)
    VALUES (?, ?)
  `);

const insertTaskRequirement = (db) =>
  db.prepare(`
    INSERT OR IGNORE INTO task_requirements (task_id, requirement_id)
    VALUES (?, ?)
  `);

// Compiles every pending intent against `core` and writes tasks +
// dependencies to `db`. Idempotent per intent: an intent whose tasks
// already exist (by id) is skipped entirely, so re-running `hedgehog
// plan` after adding a new intent doesn't touch already-compiled ones.
//
// Cross-intent ordering: for each `intent_dependencies` edge (A depends
// on B), every layer of A gets an extra `dependencies` row on that same
// layer of B — so e.g. `orders-repository` waits on `users-repository`,
// not on `users-screen`, letting independent layers of A and B proceed
// in parallel instead of serializing A's whole chain behind B's.
//
// Requirement linkage: every task an intent compiles to is linked to all
// of that intent's requirements via `task_requirements`. The compiler has
// no basis for splitting requirements across layers — a rule like
// "invitations expire after 7 days" constrains the schema, the service,
// and the screen alike — so each layer carries the whole set and the task
// packet shows the agent every rule its intent is bound by. Without this
// the traceability chain (spec: "Traceability") has no middle link:
// `hedgehog why` could reach the intent but never name the requirement a
// file satisfies.
export function planTasks(db, core) {
  const intents = loadPendingIntents(db);
  const intentDependencies = loadIntentDependencies(db);
  const ordered = orderIntents(intents, intentDependencies);

  const dependsOnByIntent = new Map();
  for (const { intent_id, depends_on_intent_id } of intentDependencies) {
    if (!dependsOnByIntent.has(intent_id)) dependsOnByIntent.set(intent_id, []);
    dependsOnByIntent.get(intent_id).push(depends_on_intent_id);
  }

  const firstLayerId = core.layers[0].id;

  const runInsert = insertTask(db);
  const runInsertDep = insertDependency(db);
  const runInsertTaskReq = insertTaskRequirement(db);

  const compiledIntentIds = [];
  const skippedIntentIds = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const intent of ordered) {
      const firstTaskId = taskId(intent.id, firstLayerId);
      if (taskExists(db, firstTaskId)) {
        skippedIntentIds.push(intent.id);
        continue;
      }

      const { tasks, dependencies } = compileIntentTasks(intent, core);
      const requirementIds = loadIntentRequirements(db, intent.id).map((r) => r.id);
      for (const t of tasks) {
        runInsert.run(
          t.id,
          t.intent_id,
          t.module,
          t.layer,
          t.objective,
          t.scope_globs,
          t.verify_command,
          t.commit_message,
          t.priority,
          t.exclusive,
          t.verify_radius,
        );
        for (const requirementId of requirementIds) {
          runInsertTaskReq.run(t.id, requirementId);
        }
      }
      for (const d of dependencies) {
        runInsertDep.run(d.task_id, d.depends_on_task_id);
      }

      // Cross-intent edge: per layer, not first-to-last — this intent's
      // layer task can't be ready until the matching layer of every
      // intent it depends_on is complete.
      for (const depIntentId of dependsOnByIntent.get(intent.id) ?? []) {
        for (const layer of core.layers) {
          runInsertDep.run(taskId(intent.id, layer.id), taskId(depIntentId, layer.id));
        }
      }

      // An intent whose tasks now exist is no longer `proposed` — it's
      // been compiled into the graph and is being built.
      db.prepare("UPDATE intents SET status = 'active' WHERE id = ?").run(intent.id);

      compiledIntentIds.push(intent.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback failing must not mask the original error.
    }
    throw err;
  }

  return { compiled: compiledIntentIds, skipped: skippedIntentIds };
}
