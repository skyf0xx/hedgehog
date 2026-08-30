// `hedgehog plan` — compiles pending intents against the project's core
// definition into `tasks` + `dependencies` rows. See
// hedgehog-persistent-build-graph.md, "The build graph" and "Task
// lifecycle", plus the readiness SELECT under "Schema".
//
// full-stack-app and pwa-app: one task per layer per intent (an intent is
// a domain module — see the core definition's `{module}` placeholder).
// landing-page, deepseek-harness, and authored (whether designed from
// scratch or adopted onto an existing repo): one task per phase/layer, no
// module axis. All are the same operation — walk a core definition's layer
// chain once per intent — because a linear chain is the degenerate case of
// the layer graph (spec: MVP scope item 5).
//
// Layer cardinality: a layer marked `once: true` in the core definition
// opts out of that per-intent multiplication and compiles a single task
// for the whole build. It's how a module-axis core expresses genuinely
// cross-cutting work — provisioning a cluster, deploying the built
// system — that is one piece of work no matter how many modules the
// graph holds. Without it such a layer compiles once per intent and
// every copy but the first is a replay of the same command.

import { composeScope, loadOverrides } from './overrides.mjs';

export function fillModule(template, module) {
  return template.replaceAll('{module}', module);
}

// Deterministic, human-legible task id: <INTENT>-<LAYER>, upper-cased.
// Stable across repeated `hedgehog plan` runs on the same intent/layer.
export function taskId(intentId, layerId) {
  return `${intentId}-${layerId}`.toUpperCase();
}

// A `once: true` layer's task id is the bare layer id — no intent
// prefix, because there is no intent it belongs to. The missing prefix
// is the signal: `DEPLOY` is the build's one deploy, `ORDERS-DEPLOY`
// would be one of several.
export function onceTaskId(layerId) {
  return layerId.toUpperCase();
}

// The once-layer counterpart to layerTaskFields: what a once: true
// layer contributes to its single task row. No {module} substitution —
// a once-layer has no module to substitute (core.mjs's validateCore
// rejects one that names {module}) — so this can't share
// layerTaskFields's body, only its role as the one place drift.mjs and
// the compiler both read from.
//
// `overrides` (a Map from overrides.mjs#loadOverrides, keyed by task id —
// here always onceTaskId(layer.id)) is composed in last, via
// composeScope, so a hand-authored .hedgehog/overrides/*.json entry
// widens scope_globs the same way for a once-task as for a per-intent
// one. Defaults to an empty Map so every existing caller that doesn't
// pass one keeps computing the un-widened fields.
export function onceLayerTaskFields(layer, overrides = new Map()) {
  const fields = {
    objective: `${layer.id} for the whole build`,
    scope_globs: JSON.stringify(layer.scope),
    verify_command: layer.verify,
    commit_message: layer.commit,
    exclusive: layer.exclusive ? 1 : 0,
    verify_radius: layer.verify_radius === null ? null : JSON.stringify(layer.verify_radius),
  };
  return composeScope(fields, onceTaskId(layer.id), overrides);
}

// `tasks.intent_id` is NOT NULL and a foreign key into `intents`, so a
// once-layer's task still needs an intent to hang off. Attributing it to
// a real intent is what this feature exists to stop — it would put
// cluster provisioning under whichever module happened to compile first,
// link it to that module's requirements, and hold that intent open until
// the infrastructure ran. So the compiler synthesises one intent, owned
// by the core rather than by any module. It is derived entirely from
// core.yaml, which makes it reproducible by `hedgehog db rebuild`
// (whereas "the first intent compiled" is not: intent order changes as
// intents are added, so a rebuild could attribute the same task
// differently). No `.hedgehog/intents/*.json` backs it — core.yaml is
// its committed source.
export const CORE_INTENT_ID = '_core';

// Also `tasks.module` for every once-layer task: the value that would be
// substituted into {module} if a once-layer were allowed to carry one
// (core.mjs's validateCore rejects that). next.mjs reads it to know a
// packet is cross-cutting rather than module-scoped.
export const CORE_MODULE = CORE_INTENT_ID;

// Once-layer tasks take the schema's default intent priority. Ordering
// between a once-layer and the modules around it is carried by the
// dependency edges, not by priority — a head once-layer is upstream of
// every module's first layer, and a tail one is downstream of every
// module's last.
const CORE_INTENT_PRIORITY = 100;

function coreIntent(core) {
  return {
    id: CORE_INTENT_ID,
    goal: `Cross-cutting layers of core "${core.id}"`,
    outcome: `Each once: true layer of "${core.id}" is built exactly once for the whole build, not once per module`,
  };
}

function layerById(core) {
  return new Map(core.layers.map((layer) => [layer.id, layer]));
}

// Compiles the core's `once: true` layers — one task each, for the whole
// build — plus the edges between two once-layers. Edges that cross the
// cardinality boundary in either direction are per-intent and belong to
// compileIntentTasks. Independent of the intent set entirely, which is
// what makes the result identical on every run.
function compileOnceTasks(core, overrides) {
  const byId = layerById(core);
  const onceLayers = core.layers.filter((layer) => layer.once);

  const tasks = onceLayers.map((layer) => ({
    id: onceTaskId(layer.id),
    intent_id: CORE_INTENT_ID,
    module: CORE_MODULE,
    layer: layer.id,
    priority: CORE_INTENT_PRIORITY,
    ...onceLayerTaskFields(layer, overrides),
  }));

  const dependencies = [];
  for (const layer of onceLayers) {
    if (!layer.depends_on) continue;
    if (!byId.get(layer.depends_on).once) continue; // per-intent parent — see compileIntentTasks
    dependencies.push({
      task_id: onceTaskId(layer.id),
      depends_on_task_id: onceTaskId(layer.depends_on),
    });
  }

  return { tasks, dependencies };
}

// Compiles one intent's tasks + the dependencies that intent contributes,
// without touching the database. Only the core's per-intent layers become
// tasks here; `once: true` layers are compiled separately, exactly once,
// by compileOnceTasks.
//
// Three of the four `depends_on` combinations are this function's, one
// row per intent:
//   per-intent → per-intent   this intent's chain link (the original case)
//   per-intent → once         every module's task waits on the single
//                             once-task, so a head infra layer gates the
//                             whole build
//   once → per-intent         the single once-task waits on this intent's
//                             task — repeated across intents, it becomes
//                             "waits on all of them", so a tail deploy
//                             layer runs after every module has landed
// The fourth (once → once) is compileOnceTasks's, since it has no
// per-intent multiplicity.

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
//
// `overrides` mirrors onceLayerTaskFields's parameter: composed in last
// via composeScope, keyed on taskId(module, layer.id) — for a per-intent
// task `module` IS the intent id, so this is exactly the id the task row
// is inserted under.
export function layerTaskFields(layer, module, overrides = new Map()) {
  const fields = {
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
  return composeScope(fields, taskId(module, layer.id), overrides);
}

// Compiles one intent's tasks + intra-intent dependencies (mirroring the
// core definition's layer order) without touching the database.
function compileIntentTasks(intent, core, overrides) {
  const module = intent.id;
  const byId = layerById(core);
  const perIntentLayers = core.layers.filter((layer) => !layer.once);

  const tasks = perIntentLayers.map((layer) => ({
    id: taskId(intent.id, layer.id),
    intent_id: intent.id,
    module,
    layer: layer.id,
    priority: intent.priority,
    ...layerTaskFields(layer, module, overrides),
  }));

  const dependencies = [];
  for (const layer of core.layers) {
    if (!layer.depends_on) continue;
    const parent = byId.get(layer.depends_on);
    if (layer.once && parent.once) continue; // compileOnceTasks owns this edge
    dependencies.push({
      task_id: layer.once ? onceTaskId(layer.id) : taskId(intent.id, layer.id),
      depends_on_task_id: parent.once
        ? onceTaskId(parent.id)
        : taskId(intent.id, parent.id),
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

// Exported for drift.mjs: expected cross-intent task edges (see
// planTasks's "Cross-intent edge" comment below) depend on which
// intents depend on which, and that's `intent_dependencies` regardless
// of the intents' own compiled/pending status.
export function loadIntentDependencies(db) {
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

// Real intents only — the synthesised core intent doesn't count, or the
// once-layer bootstrap below would fire on a graph with no work in it.
function countRealIntents(db) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM intents WHERE id <> ?')
    .get(CORE_INTENT_ID).n;
}

// Inserts the synthesised core intent if it isn't there yet. Written
// straight to 'active': it is compiled at the moment it's created, and it
// must never be picked up as a pending intent by loadPendingIntents.
// A pre-existing row with a different goal is a user intent squatting on
// the reserved id — intent.mjs refuses to create one, so this only fires
// on a graph predating that guard.
function ensureCoreIntent(db, core) {
  const intent = coreIntent(core);
  const existing = db
    .prepare('SELECT goal FROM intents WHERE id = ?')
    .get(CORE_INTENT_ID);

  if (existing === undefined) {
    db.prepare(
      `INSERT INTO intents (id, goal, outcome, priority, status)
       VALUES (?, ?, ?, ?, 'active')`,
    ).run(intent.id, intent.goal, intent.outcome, CORE_INTENT_PRIORITY);
    return;
  }

  if (existing.goal !== intent.goal) {
    throw new Error(
      `intent id "${CORE_INTENT_ID}" is reserved for the core's once: true layers, but an unrelated intent already holds it`,
    );
  }
}

// A once-layer is the only task whose prerequisite set can grow *after*
// it has completed: `planner`'s Re-entry pass adds a new intent to a
// finished build, and a tail once-layer picks up that new module's task
// as a prerequisite. Left complete, the new module can finish and the
// graph reports the whole build done while the build-wide deploy never
// ran for it — a green graph over work that did not happen.
//
// So it is reopened. Re-running is what the layer is for: cross-cutting
// infrastructure work is idempotent by construction (`terraform apply`
// against its own state, `kubectl apply` per object), and the earlier
// commit stays in history untouched — this moves the task's status, not
// the record of what it already did.
//
// Not reopened: per-module tasks downstream of a once-layer. Their
// commits are real work on files that still exist and still pass, and
// re-running them is a Correction Protocol decision rather than
// something `plan` should do silently to already-built modules.
function reopenOnceTask(db, taskId, intentId) {
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
  if (row === undefined) return false;

  // An agent is running it right now against the old prerequisite set.
  // Slipping a new dependency under a live lease would either be ignored
  // (it verifies and completes anyway) or corrupt the lease invariant on
  // the way back to `planned`. Refuse the whole plan run instead.
  if (row.status === 'building' || row.status === 'verifying') {
    throw new Error(
      `once: true task "${taskId}" is ${row.status} right now, and intent "${intentId}" adds a new prerequisite to it — let it finish (or \`hedgehog release ${taskId}\`) and run \`hedgehog plan\` again`,
    );
  }

  if (row.status !== 'complete') return false;
  db.prepare("UPDATE tasks SET status = 'planned', blocked_reason = NULL WHERE id = ?").run(
    taskId,
  );
  return true;
}

// Reopens each seed once-task, then walks once → once edges so a
// once-layer downstream of a reopened one reopens too — its input changed
// for the same reason.
function reopenOnceTasks(db, core, seeds) {
  const byId = layerById(core);
  const onceChildren = new Map();
  for (const layer of core.layers) {
    if (!layer.once || !layer.depends_on) continue;
    if (!byId.get(layer.depends_on).once) continue;
    const parentId = onceTaskId(layer.depends_on);
    if (!onceChildren.has(parentId)) onceChildren.set(parentId, []);
    onceChildren.get(parentId).push(onceTaskId(layer.id));
  }

  const reopened = [];
  const seen = new Set();
  const frontier = [...seeds];
  while (frontier.length > 0) {
    const { id, intentId } = frontier.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (reopenOnceTask(db, id, intentId)) reopened.push(id);
    for (const childId of onceChildren.get(id) ?? []) {
      frontier.push({ id: childId, intentId });
    }
  }

  if (reopened.length > 0) {
    // The synthesised intent is no longer finished either.
    db.prepare("UPDATE intents SET status = 'active' WHERE id = ?").run(CORE_INTENT_ID);
  }
  return reopened.sort();
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
//
// Once-layers: compiled before the intent loop, in the same transaction,
// and only if the graph already holds at least one real intent. They are
// skipped by id like everything else, so a second `hedgehog plan` after a
// fourth intent is added re-uses the single existing task instead of
// compiling a second copy. Adding `once` to a core whose intents are
// already compiled is a core-definition change, not a plan run: the
// already-compiled intents are skipped and so contribute no edges to the
// new once-layer. Delete `.hedgehog/hedgehog.db` and `hedgehog db
// rebuild` to recompile the whole graph against the new definition.
//
// `overrides` (from overrides.mjs#loadOverrides) is composed into every
// task's scope_globs at the moment it's compiled, via layerTaskFields /
// onceLayerTaskFields. A task compiled before its override file existed
// does NOT pick it up here — planTasks only ever INSERTs — so an
// override written after the fact needs `hedgehog plan --recompile`
// (drift.mjs composes the same overrides Map) the same as any other
// core.yaml-derived field would.
//
// `excludeIntentIds` (worktree.mjs's eligibleIntents feeds this, from
// `hedgehog plan`) is the set of pending intents this call leaves
// untouched — neither compiled nor skipped-as-already-compiled, simply
// not considered. It exists for exactly one caller: an intent whose
// `intent_dependencies` just cleared is worktree-eligible, and its tasks
// belong in that worktree's own graph, never in the one `planTasks` is
// running against here (trunk). Defaulted to an empty Set, so every
// existing caller — including a project that never uses worktrees — sees
// the identical behavior this function always had.
//
// Expanded to its transitive closure before anything else reads it: an
// intent C that `--depends-on` an excluded intent B is not itself
// worktree-eligible (eligibleIntents requires B to be `complete`, and an
// excluded-but-not-yet-merged B never is), so left out of the exclusion
// set C would still compile onto trunk here — and the cross-intent edge
// loop below would then try to INSERT a `dependencies` row onto one of
// B's task ids, which was never inserted anywhere (B's tasks exist only
// in B's own worktree, if it has one yet, or nowhere at all if it's still
// waiting on its own commit — see the `pending` branch in
// bin/cli.mjs#planCommand). `dependencies.depends_on_task_id` is a
// FOREIGN KEY with no bypass (schema.mjs, `foreign_keys = ON`), so that
// INSERT throws and aborts the whole `hedgehog plan` transaction. Mirrors
// eligibleIntents' own rule — a dependency has to be actually finished
// before its dependent can proceed — rather than inventing a second rule
// here that could drift from it.
function expandExcludedIntentIds(excludeIntentIds, intentDependencies) {
  if (excludeIntentIds.size === 0) return excludeIntentIds;

  const dependsOn = new Map();
  for (const { intent_id, depends_on_intent_id } of intentDependencies) {
    if (!dependsOn.has(intent_id)) dependsOn.set(intent_id, []);
    dependsOn.get(intent_id).push(depends_on_intent_id);
  }

  const expanded = new Set(excludeIntentIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [intentId, deps] of dependsOn) {
      if (expanded.has(intentId)) continue;
      if (deps.some((depId) => expanded.has(depId))) {
        expanded.add(intentId);
        changed = true;
      }
    }
  }
  return expanded;
}

export function planTasks(db, core, overrides = new Map(), { excludeIntentIds = new Set() } = {}) {
  const intentDependencies = loadIntentDependencies(db);
  const effectiveExcludeIntentIds = expandExcludedIntentIds(excludeIntentIds, intentDependencies);
  const intents = loadPendingIntents(db).filter(
    (intent) => !effectiveExcludeIntentIds.has(intent.id),
  );
  const ordered = orderIntents(intents, intentDependencies);

  const dependsOnByIntent = new Map();
  for (const { intent_id, depends_on_intent_id } of intentDependencies) {
    if (!dependsOnByIntent.has(intent_id)) dependsOnByIntent.set(intent_id, []);
    dependsOnByIntent.get(intent_id).push(depends_on_intent_id);
  }

  const perIntentLayers = core.layers.filter((layer) => !layer.once);
  // validateCore guarantees at least one per-intent layer. The skip check
  // has to key on the first *per-intent* layer, not core.layers[0]: with a
  // once-layer at the head, core.layers[0]'s task id is the same for every
  // intent, so every intent after the first would look already-compiled
  // and silently compile nothing.
  const firstLayerId = perIntentLayers[0].id;
  const onceTaskIds = new Set(
    core.layers.filter((layer) => layer.once).map((layer) => onceTaskId(layer.id)),
  );

  const runInsert = insertTask(db);
  const runInsertDep = insertDependency(db);
  const runInsertTaskReq = insertTaskRequirement(db);

  const compiledIntentIds = [];
  const skippedIntentIds = [];
  const compiledOnceTaskIds = [];
  // Once-tasks that a newly compiled intent hangs a prerequisite on.
  const onceTasksGainingPrereqs = [];
  let reopenedOnceTaskIds = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    if (onceTaskIds.size > 0 && countRealIntents(db) > 0) {
      ensureCoreIntent(db, core);
      const { tasks, dependencies } = compileOnceTasks(core, overrides);
      for (const t of tasks) {
        if (taskExists(db, t.id)) continue;
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
        compiledOnceTaskIds.push(t.id);
      }
      for (const d of dependencies) {
        runInsertDep.run(d.task_id, d.depends_on_task_id);
      }
    }

    for (const intent of ordered) {
      const firstTaskId = taskId(intent.id, firstLayerId);
      if (taskExists(db, firstTaskId)) {
        skippedIntentIds.push(intent.id);
        continue;
      }

      const { tasks, dependencies } = compileIntentTasks(intent, core, overrides);
      const requirementIds = loadIntentRequirements(db, intent.id).map((r) => r.id);
      for (const t of tasks) {
        // <INTENT>-<LAYER> colliding with a bare once-layer id would
        // otherwise surface as a primary-key failure mid-transaction.
        if (onceTaskIds.has(t.id)) {
          throw new Error(
            `task "${t.id}" for intent "${intent.id}" collides with the id of once: true layer "${t.id.toLowerCase()}" — rename the layer or the intent`,
          );
        }
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
        if (onceTaskIds.has(d.task_id)) {
          onceTasksGainingPrereqs.push({ id: d.task_id, intentId: intent.id });
        }
      }

      // Cross-intent edge: per layer, not first-to-last — this intent's
      // layer task can't be ready until the matching layer of every
      // intent it depends_on is complete. Once-layers have no per-intent
      // counterpart to pair up, and pairing one with itself would be a
      // self-edge the `dependencies` CHECK rejects outright.
      for (const depIntentId of dependsOnByIntent.get(intent.id) ?? []) {
        for (const layer of perIntentLayers) {
          runInsertDep.run(taskId(intent.id, layer.id), taskId(depIntentId, layer.id));
        }
      }

      // An intent whose tasks now exist is no longer `proposed` — it's
      // been compiled into the graph and is being built.
      db.prepare("UPDATE intents SET status = 'active' WHERE id = ?").run(intent.id);

      compiledIntentIds.push(intent.id);
    }

    reopenedOnceTaskIds = reopenOnceTasks(db, core, onceTasksGainingPrereqs);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback failing must not mask the original error.
    }
    throw err;
  }

  return {
    compiled: compiledIntentIds,
    skipped: skippedIntentIds,
    once: compiledOnceTaskIds,
    reopened: reopenedOnceTaskIds,
  };
}
