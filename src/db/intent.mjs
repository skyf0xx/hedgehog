// `hedgehog intent add` — writes one intent record (`intents` +
// `requirements` + `intent_dependencies` rows) from either CLI flags or a
// JSON file matching the intent record shape. See
// hedgehog-persistent-build-graph.md, "Intent records".
//
// The primary human input is compact and outcome-oriented:
//   { id, goal, outcome, rules: [...], depends_on: [...], priority }
// `rules` become `requirements` rows with kind='rule'. `depends_on` become
// `intent_dependencies` rows. Constraint/acceptance requirements aren't
// part of the flag surface (no natural repeatable-flag shape for two
// distinct kinds) but are accepted from a JSON file via `constraints` /
// `acceptance` arrays, alongside `rules`.
//
// Every intent is also written as its own committed JSON file under
// INTENTS_DIR — the DB is a derived artifact (rebuildable via `hedgehog db
// rebuild`), so the intent itself has to survive independently of it, as
// plain text a PR can review and a fresh clone can replay.

import { mkdir, writeFile } from 'node:fs/promises';
import { CORE_INTENT_ID } from './plan.mjs';

export const INTENTS_DIR = '.hedgehog/intents';

const REQUIREMENT_KIND_FIELDS = {
  rule: 'rules',
  constraint: 'constraints',
  acceptance: 'acceptance',
};

function requirementId(intentId, kind, index) {
  return `${intentId}-${kind}-${index + 1}`.toUpperCase();
}

// Normalizes either source (parsed JSON file, or flags already collected
// into the same shape) into the exact rows to insert. Throws on missing
// required fields — id/goal/outcome are NOT NULL in the schema.
export function normalizeIntent(record) {
  const { id, goal, outcome, priority, depends_on: dependsOn } = record;

  if (!id) throw new Error('intent requires an id');
  // plan.mjs synthesises this intent from core.yaml to own the tasks of
  // `once: true` layers. A user intent on the same id would have its
  // cross-cutting tasks silently merged into it.
  if (id === CORE_INTENT_ID) {
    throw new Error(
      `intent id "${CORE_INTENT_ID}" is reserved for the core's once: true layers`,
    );
  }
  if (!goal) throw new Error('intent requires a goal');
  if (!outcome) throw new Error('intent requires an outcome');

  const requirements = [];
  for (const [kind, field] of Object.entries(REQUIREMENT_KIND_FIELDS)) {
    const statements = record[field] ?? [];
    statements.forEach((statement, index) => {
      requirements.push({ id: requirementId(id, kind, index), kind, statement });
    });
  }

  const dependsOnIds = dependsOn ?? [];
  if (dependsOnIds.includes(id)) {
    throw new Error(`intent "${id}" cannot depend on itself`);
  }

  return {
    id,
    goal,
    outcome,
    priority: priority ?? 100,
    requirements,
    depends_on: dependsOnIds,
  };
}

const insertIntent = (db) =>
  db.prepare(`
    INSERT INTO intents (id, goal, outcome, priority)
    VALUES (?, ?, ?, ?)
  `);

const insertRequirement = (db) =>
  db.prepare(`
    INSERT INTO requirements (id, intent_id, kind, statement)
    VALUES (?, ?, ?, ?)
  `);

const insertIntentDependency = (db) =>
  db.prepare(`
    INSERT INTO intent_dependencies (intent_id, depends_on_intent_id)
    VALUES (?, ?)
  `);

// Writes a normalized intent (see normalizeIntent) to `db`: one `intents`
// row, one `requirements` row per rule/constraint/acceptance item, one
// `intent_dependencies` row per depends_on entry. All in one transaction.
// Also writes the same normalized shape to INTENTS_DIR/<id>.json, ahead of
// the DB transaction, so the intent is recoverable even if the DB write
// fails after — belt and suspenders, not a two-phase commit.
export async function addIntent(db, record) {
  const intent = normalizeIntent(record);

  await mkdir(INTENTS_DIR, { recursive: true });
  await writeFile(`${INTENTS_DIR}/${intent.id}.json`, JSON.stringify(intent, null, 2));

  const runInsertIntent = insertIntent(db);
  const runInsertRequirement = insertRequirement(db);
  const runInsertDependency = insertIntentDependency(db);

  db.exec('BEGIN IMMEDIATE');
  try {
    runInsertIntent.run(intent.id, intent.goal, intent.outcome, intent.priority);
    for (const r of intent.requirements) {
      runInsertRequirement.run(r.id, intent.id, r.kind, r.statement);
    }
    for (const dependsOnId of intent.depends_on) {
      runInsertDependency.run(intent.id, dependsOnId);
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

  return intent;
}
