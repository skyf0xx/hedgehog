// Core-definition drift: what `hedgehog plan` copied onto a task row
// versus what `core.yaml` says today.
//
// `plan` compiles intents × layers into `tasks` rows, copying each
// layer's scope globs, verify command, commit message, exclusivity and
// verify radius onto every row (plan.mjs#layerTaskFields). From that
// moment the row — not core.yaml — is what `hedgehog next`, `claim` and
// `verify` actually read. An edit to core.yaml after the fact therefore
// changes nothing about already-compiled work, and `plan` won't revisit
// it: it only reads intents still `proposed`/`planned`, and compiling an
// intent flips it to `active`.
//
// That silence is the bug this module exists to end. It provides:
//
//   detectDrift(db, core)     — every task whose layer-derived fields no
//                               longer match core.yaml, plus the two
//                               kinds of divergence a field rewrite
//                               can't fix (a layer that left core.yaml,
//                               and a changed `depends_on` edge).
//   recompileTasks(db, core)  — rewrites those fields on tasks nothing
//                               has acted on yet, and refuses the rest.
//
// The split mirrors status.mjs's: a pure data function, and a formatter
// the CLI prints.

import { LAYER_DERIVED_FIELDS, layerTaskFields, taskId } from './plan.mjs';

// Statuses a field rewrite is safe on: nothing has been built, leased,
// committed, or failed against these rows yet, so moving their ALLOWED
// SCOPE / verify command / commit message changes only what a future
// agent will be handed.
export const RECOMPILABLE_STATUSES = ['proposed', 'planned', 'ready'];

// `blocked` is the one judgement call. The row carries no lease and no
// commit, so writing it is mechanically safe — and a blocked task is
// exactly where a broken verify command lands, which is the case that
// motivated this command. But an agent's work for it is already sitting
// in the working tree against the old scope, so it is opt-in
// (`--include-blocked`) rather than part of the default sweep.
export const OPT_IN_STATUSES = ['blocked'];

const SKIP_REASONS = {
  building: 'an agent holds a lease and is building against these fields',
  verifying: 'a verification run is in flight against these fields',
  complete: 'already built and committed under the old commit message',
  blocked: 'work already exists against the old fields — pass --include-blocked to rewrite anyway',
};

function normalize(value) {
  // node:sqlite hands back INTEGER columns as BigInt on some builds;
  // compare as strings so 0 and 0n don't read as drift.
  if (value === null || value === undefined) return null;
  return String(value);
}

function loadTasks(db) {
  return db.prepare('SELECT * FROM tasks ORDER BY priority, id').all();
}

// The intra-intent dependency edges recorded for `taskId`. Cross-intent
// edges (planTasks writes one per depends_on intent, same layer) are
// excluded by joining back to tasks and keeping only parents in the same
// intent — so this compares like with like against `layer.depends_on`.
function intraIntentParents(db, task) {
  return db
    .prepare(
      `SELECT d.depends_on_task_id AS id FROM dependencies d
         JOIN tasks p ON p.id = d.depends_on_task_id
        WHERE d.task_id = ? AND p.intent_id = ?
        ORDER BY d.depends_on_task_id`,
    )
    .all(task.id, task.intent_id)
    .map((r) => r.id);
}

// Drift for one task. Returns null when the row matches core.yaml.
//
// Three shapes of divergence, deliberately kept apart because only the
// first is something `--recompile` can fix:
//   fields          — a layer-derived column differs (rewritable)
//   missingLayer    — the task's layer is no longer in core.yaml
//   dependencyDrift — the layer's `depends_on` changed, so the graph's
//                     edges are wrong (a shape change, not a field one)
export function taskDrift(db, task, core) {
  const layer = core.layers.find((l) => l.id === task.layer);
  if (!layer) {
    return {
      id: task.id,
      layer: task.layer,
      status: task.status,
      fields: [],
      missingLayer: true,
      dependencyDrift: null,
    };
  }

  const expected = layerTaskFields(layer, task.module);
  const fields = [];
  for (const field of LAYER_DERIVED_FIELDS) {
    const want = normalize(expected[field]);
    const have = normalize(task[field]);
    if (want !== have) fields.push({ field, expected: expected[field], actual: task[field] });
  }

  const expectedParents = layer.depends_on ? [taskId(task.intent_id, layer.depends_on)] : [];
  const actualParents = intraIntentParents(db, task);
  const dependencyDrift =
    expectedParents.join(',') === actualParents.join(',')
      ? null
      : { expected: expectedParents, actual: actualParents };

  if (fields.length === 0 && !dependencyDrift) return null;

  return {
    id: task.id,
    layer: task.layer,
    status: task.status,
    fields,
    missingLayer: false,
    dependencyDrift,
  };
}

// True when `--recompile` may rewrite this task's fields.
export function isRecompilable(status, { includeBlocked = false } = {}) {
  if (RECOMPILABLE_STATUSES.includes(status)) return true;
  return includeBlocked && OPT_IN_STATUSES.includes(status);
}

// Every drifted task, in `priority, id` order. Read-only.
export function detectDrift(db, core, { includeBlocked = false } = {}) {
  const drifted = [];
  for (const task of loadTasks(db)) {
    const drift = taskDrift(db, task, core);
    if (!drift) continue;
    drift.recompilable =
      drift.fields.length > 0 && !drift.missingLayer && isRecompilable(task.status, { includeBlocked });
    drift.skipReason = drift.recompilable
      ? null
      : drift.missingLayer
        ? `layer "${task.layer}" is no longer in core.yaml`
        : drift.fields.length === 0
          ? 'only the dependency edges drifted, which --recompile does not rewrite'
          : (SKIP_REASONS[task.status] ?? `status "${task.status}" is not recompilable`);
    drifted.push(drift);
  }
  return drifted;
}

const UPDATE_SQL = `
  UPDATE tasks
     SET objective = ?, scope_globs = ?, verify_command = ?,
         commit_message = ?, exclusive = ?, verify_radius = ?
   WHERE id = ?
`;

// Rewrites the layer-derived fields of every drifted, not-yet-started
// task from the current core.yaml, and refuses the rest. One
// transaction: either the whole reconciliation lands or none of it does,
// so a half-recompiled graph is never a state anyone has to reason
// about.
//
// Returns { updated, skipped } — `updated` the tasks rewritten (with the
// field list), `skipped` the drifted tasks left alone (with the reason
// and the fields that stay stale). `dryRun` computes both without
// writing.
export function recompileTasks(db, core, { includeBlocked = false, dryRun = false } = {}) {
  const drifted = detectDrift(db, core, { includeBlocked });
  const updated = drifted.filter((d) => d.recompilable);
  const skipped = drifted.filter((d) => !d.recompilable);

  if (dryRun || updated.length === 0) return { updated, skipped };

  const run = db.prepare(UPDATE_SQL);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const drift of updated) {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(drift.id);
      // Re-read the status inside the write transaction: a concurrent
      // `claim` could have leased the task between detectDrift and here,
      // and a rewrite under a live lease is exactly what this refuses.
      if (!isRecompilable(task.status, { includeBlocked })) {
        drift.recompilable = false;
        drift.skipReason = SKIP_REASONS[task.status] ?? `status "${task.status}" is not recompilable`;
        continue;
      }
      const layer = core.layers.find((l) => l.id === task.layer);
      const fields = layerTaskFields(layer, task.module);
      run.run(
        fields.objective,
        fields.scope_globs,
        fields.verify_command,
        fields.commit_message,
        fields.exclusive,
        fields.verify_radius,
        task.id,
      );
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

  return {
    updated: updated.filter((d) => d.recompilable),
    skipped: [...skipped, ...updated.filter((d) => !d.recompilable)],
  };
}

function shorten(value) {
  if (value === null || value === undefined) return '(none)';
  const s = String(value);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

// The per-field detail block both `status` and `plan --recompile` print
// under a drifted task — core.yaml's value against the compiled one, so
// the divergence is legible without opening SQLite.
function driftDetailLines(drift, indent = '    ') {
  const lines = [];
  if (drift.missingLayer) {
    lines.push(`${indent}layer "${drift.layer}" is no longer defined in core.yaml`);
  }
  for (const { field, expected, actual } of drift.fields) {
    lines.push(`${indent}${field}`);
    lines.push(`${indent}  core.yaml: ${shorten(expected)}`);
    lines.push(`${indent}  task:      ${shorten(actual)}`);
  }
  if (drift.dependencyDrift) {
    const { expected, actual } = drift.dependencyDrift;
    lines.push(`${indent}depends_on (graph edges — not rewritten by --recompile)`);
    lines.push(`${indent}  core.yaml: ${expected.length ? expected.join(', ') : '(none)'}`);
    lines.push(`${indent}  graph:     ${actual.length ? actual.join(', ') : '(none)'}`);
  }
  return lines;
}

// The DRIFT block `hedgehog status` appends. Empty string when the graph
// matches core.yaml, so the section only ever appears when it matters.
export function formatDrift(drifted) {
  if (drifted.length === 0) return '';
  const lines = [];
  lines.push('DRIFT');
  lines.push(
    `  ${drifted.length} task(s) no longer match .hedgehog/core.yaml — the compiled task is what`,
  );
  lines.push('  `hedgehog next`/`claim`/`verify` actually use, not core.yaml.');
  lines.push('');
  for (const drift of drifted) {
    const fieldList = drift.fields.map((f) => f.field).join(', ');
    const suffix = drift.recompilable ? '' : ` — ${drift.skipReason}`;
    lines.push(`  ${drift.id}   ${drift.status}   ${fieldList || '(structure)'}${suffix}`);
    lines.push(...driftDetailLines(drift));
  }
  lines.push('');
  lines.push('  Reconcile the not-started ones with: hedgehog plan --recompile');
  return lines.join('\n');
}

// The report `hedgehog plan --recompile` prints.
export function formatRecompile({ updated, skipped }) {
  const lines = [];
  for (const drift of updated) {
    lines.push(
      `  updated  ${drift.id}   ${drift.status}   ${drift.fields.map((f) => f.field).join(', ')}`,
    );
  }
  for (const drift of skipped) {
    lines.push(`  skipped  ${drift.id}   ${drift.status}   ${drift.skipReason}`);
    lines.push(...driftDetailLines(drift, '             '));
  }
  lines.push('');
  lines.push(
    `${updated.length} task(s) updated, ${skipped.length} task(s) skipped`,
  );
  return lines.join('\n');
}
