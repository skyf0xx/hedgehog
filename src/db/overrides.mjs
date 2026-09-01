// `.hedgehog/overrides/*.json` — per-task scope exceptions.
//
// A module-axis core's layer scope is a template applied to every module
// alike (`apps/api/src/{module}/http/**`), and core.mjs#validateCore
// requires every layer to carry `{module}` on such a core specifically so
// no layer can special-case one module over another. That uniformity is
// the point — a scope widened in the layer definition grants the same
// extra reach to every module's task, not just the one that needs it.
//
// Real builds still hit tasks that need to touch one file outside their
// module: a composition seam nobody's layer owns (binding a port the
// module declared, registering a route in a shared router). Before this,
// the only move was a direct `UPDATE tasks SET scope_globs = ...` in
// SQLite — invisible to `git diff`, absent from the permanent record
// (`.hedgehog/intents/*.json`, `core.yaml`, the commit history), and
// silently dropped by `hedgehog db rebuild`, which re-derives scope_globs
// from core.yaml alone and has no idea the hand-edit ever existed.
//
// An override file closes that gap the same way `.hedgehog/intents/*.json`
// already does for intents: committed, plain text, replayed by both
// `planTasks` (at compile time) and `rebuildDb` (on every rebuild) through
// the same `composeScope` this module exports. `detectDrift` reads through
// it too — an overridden task's expected scope is core.yaml's layer
// composed with its override, not core.yaml's layer alone, or every
// overridden task would report permanent, unfixable drift.
//
// Three constraints, load-bearing rather than incidental:
//   - additive only: `scope_add`, never a replace or a shrink. An
//     override widens what a task may touch; it can never narrow the
//     gate `core.yaml` already set.
//   - one task, not a layer or a module. A per-layer override is a layer
//     edit wearing a disguise and reintroduces the "widens for all six
//     modules" problem this exists to avoid.
//   - no `verify` overrides. Weakening a layer's verify command is the
//     one thing the discipline forbids outright, override file or not — a
//     wrong verify command belongs in core.yaml, corrected through
//     `hedgehog plan --recompile`.

import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';

export const OVERRIDES_DIR = '.hedgehog/overrides';

function overrideFilePath(taskId, overridesDir = OVERRIDES_DIR) {
  return `${overridesDir}/${taskId.toLowerCase()}.json`;
}

// Validates one parsed override record. Throws with the offending file's
// path in the message — this runs at load time, over every file in the
// directory, so a bad record has to name itself to be findable.
function validateOverride(record, path) {
  if (record === null || typeof record !== 'object') {
    throw new Error(`${path}: override must be a JSON object`);
  }
  let { task } = record;
  const { scope_add: scopeAdd, reason } = record;

  if (!task || typeof task !== 'string') {
    throw new Error(`${path}: override requires a "task" id (string)`);
  }
  // plan.mjs#taskId / #onceTaskId always upper-case the id they compile a
  // task under, and composeScope looks up this Map by that exact string —
  // so a lower- or mixed-case "task" here (e.g. the CLI's own convention
  // of lowercase-with-dashes elsewhere, "orders-api") would key a Map
  // entry composeScope can never match, silently no-op-ing the override at
  // every call site (plan/recompile/rebuild/detectDrift) with no error.
  // Normalizing here, once, is what keeps the Map key space exact-match
  // everywhere else.
  task = task.toUpperCase();
  if (!Array.isArray(scopeAdd) || scopeAdd.length === 0) {
    throw new Error(`${path}: override "${task}" requires a non-empty "scope_add" array`);
  }
  for (const glob of scopeAdd) {
    if (typeof glob !== 'string' || glob.trim() === '') {
      throw new Error(`${path}: override "${task}" has a non-string or empty entry in scope_add`);
    }
  }
  if (!reason || typeof reason !== 'string') {
    throw new Error(
      `${path}: override "${task}" requires a "reason" (string) — this is the permanent record of why the task's scope was widened`,
    );
  }

  // Reject the two shapes the issue's design explicitly rules out, rather
  // than silently ignoring the fields: a typo'd attempt at either is much
  // more likely than a deliberate probe of the boundary, and failing loud
  // surfaces it at load time instead of at "why did this task's verify
  // command change".
  if ('scope_replace' in record) {
    throw new Error(
      `${path}: override "${task}" has "scope_replace", which this file format does not support — overrides are additive only (scope_add)`,
    );
  }
  if ('verify' in record || 'verify_command' in record) {
    throw new Error(
      `${path}: override "${task}" attempts to override verify — not permitted. A wrong verify command belongs in core.yaml, reconciled via "hedgehog plan --recompile"`,
    );
  }

  return { task, scope_add: [...scopeAdd], reason };
}

// Reads every *.json file in `overridesDir`, validates each, and returns
// a Map from task id to its list of override records (a task could in
// principle be widened more than once, by separate files with separate
// reasons — each stays a distinct, individually-reviewable entry rather
// than being merged into one).
//
// Absent directory reads as "no overrides", the same way
// rebuild.mjs#loadIntentFiles treats a missing .hedgehog/intents/.
export async function loadOverrides(overridesDir = OVERRIDES_DIR) {
  let entries;
  try {
    entries = await readdir(overridesDir);
  } catch {
    return new Map();
  }

  const byTask = new Map();
  for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
    const path = `${overridesDir}/${name}`;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      throw new Error(`could not read override file ${path}: ${err.message}`, { cause: err });
    }
    const record = validateOverride(parsed, path);
    if (!byTask.has(record.task)) byTask.set(record.task, []);
    byTask.get(record.task).push(record);
  }
  return byTask;
}

// Every scope_add glob recorded for `taskId`, flattened across however
// many override files name it, in file order (loadOverrides sorts by
// filename, so this is deterministic across machines and runs).
export function scopeAddFor(overrides, taskId) {
  const records = overrides.get(taskId) ?? [];
  return records.flatMap((r) => r.scope_add);
}

// Override task ids that never match a row in `tasks` — a typo'd id, a
// task from a renamed module/layer, or a legitimately future one (the
// intent it belongs to hasn't compiled yet). validateOverride only checks
// shape, not whether the id is real, because it runs before a DB
// connection is available (`hedgehog override add` writes a file; it
// doesn't compile anything) — this is the read side that closes the gap,
// so a dead override has *some* discovery path instead of silently
// widening nothing forever with no error and no drift signal (composeScope
// composing a non-matching key is a no-op, not a throw).
export function orphanedOverrides(db, overrides) {
  const known = new Set(db.prepare('SELECT id FROM tasks').all().map((r) => r.id));
  return [...overrides.keys()].filter((taskId) => !known.has(taskId)).sort();
}

// Composes a task-fields object (as produced by plan.mjs's
// layerTaskFields/onceLayerTaskFields) with its overrides — the single
// place `scope_globs` is widened, shared by planTasks, recompileTasks and
// detectDrift so the three can never compute a different "expected scope"
// for the same task. Additive only: the result's scope_globs is always a
// superset of `fields.scope_globs`, glob-for-glob, in core.yaml's order
// followed by scope_add's.
export function composeScope(fields, taskId, overrides) {
  const add = scopeAddFor(overrides, taskId);
  if (add.length === 0) return fields;

  const base = JSON.parse(fields.scope_globs);
  const merged = [...base];
  for (const glob of add) {
    if (!merged.includes(glob)) merged.push(glob);
  }
  return { ...fields, scope_globs: JSON.stringify(merged) };
}

// Writes one override record to OVERRIDES_DIR/<task-id-lowercased>.json,
// via temp-file + rename so a crash mid-write can never leave a
// half-written file for loadOverrides to trip on — the same pattern
// intent.mjs#writeIntentFile uses for the same reason.
//
// Refuses to overwrite an existing file silently: a second `hedgehog
// override add` for the same task is far more likely to be a mistake
// (wrong task id, forgot it was already done) than an intentional
// replacement, and unlike scope_add's own merge, a second file for the
// same task is the supported way to add a second, separately-reasoned
// exception rather than to edit the first one.
export async function writeOverrideFile(record, overridesDir = OVERRIDES_DIR) {
  const path = overrideFilePath(record.task, overridesDir);
  try {
    await readFile(path, 'utf8');
    throw new Error(
      `${path} already exists — edit it directly, or pick a different filename, rather than re-running "hedgehog override add" for the same task`,
    );
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  await mkdir(overridesDir, { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tempPath, JSON.stringify(record, null, 2));
    await rename(tempPath, path);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  return record;
}

// Validates and writes a new override in one step — the `hedgehog
// override add` entry point. Validates against the same rules
// loadOverrides enforces, so a record this function accepts is guaranteed
// loadable.
export async function addOverride({ task, scope_add: scopeAdd, reason }, overridesDir = OVERRIDES_DIR) {
  const record = validateOverride({ task, scope_add: scopeAdd, reason }, '(new override)');
  return writeOverrideFile(record, overridesDir);
}
