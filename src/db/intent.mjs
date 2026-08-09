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
//
// Because that file IS the permanent record, two properties matter more
// than they look:
//
//   * `normalizeIntent` must round-trip its own output. It emits
//     `requirements`, so it has to read `requirements` as well as the
//     `rules`/`constraints`/`acceptance` input arrays — otherwise
//     re-normalizing an already-written file (which is exactly what a
//     replay does) yields zero requirements and the rewrite empties the
//     record.
//   * the DB insert and the file write are all-or-nothing. The inserts
//     run first (so a record the DB rejects never reaches the file) but
//     the file write happens before COMMIT (so a failed write rolls the
//     inserts back). Neither half can outlive the other, and a write
//     that would drop a non-empty record to zero requirements is refused
//     outright. Losing a committed intent is strictly worse than failing
//     loudly.

import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';

export const INTENTS_DIR = '.hedgehog/intents';

const REQUIREMENT_KIND_FIELDS = {
  rule: 'rules',
  constraint: 'constraints',
  acceptance: 'acceptance',
};

const REQUIREMENT_KINDS = new Set(Object.keys(REQUIREMENT_KIND_FIELDS));

function requirementId(intentId, kind, index) {
  return `${intentId}-${kind}-${index + 1}`.toUpperCase();
}

export function intentFilePath(intentId, intentsDir = INTENTS_DIR) {
  return `${intentsDir}/${intentId}.json`;
}

// Collects requirements from BOTH shapes this function can be handed:
// the input arrays (`rules`/`constraints`/`acceptance`, from CLI flags or
// a hand-written JSON file) and the already-normalized `requirements`
// array this same function emits. Reading only the former is what made
// re-normalizing a written file destructive.
//
// Ids are preserved when the entry carries one, generated per-kind by
// position otherwise, and deduplicated by id so a record holding both
// shapes doesn't double-count.
function collectRequirements(record, intentId) {
  const requirements = [];
  const seenIds = new Set();
  const perKindCount = { rule: 0, constraint: 0, acceptance: 0 };

  const push = (kind, statement, explicitId) => {
    if (!REQUIREMENT_KINDS.has(kind)) {
      throw new Error(
        `intent "${intentId}" has a requirement of unknown kind "${kind}" ` +
          `(expected one of: ${[...REQUIREMENT_KINDS].join(', ')})`,
      );
    }
    if (typeof statement !== 'string' || statement.trim() === '') {
      throw new Error(`intent "${intentId}" has a ${kind} requirement with no statement`);
    }
    const id = explicitId ?? requirementId(intentId, kind, perKindCount[kind]);
    perKindCount[kind]++;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    requirements.push({ id, kind, statement });
  };

  for (const [kind, field] of Object.entries(REQUIREMENT_KIND_FIELDS)) {
    const statements = record[field] ?? [];
    if (!Array.isArray(statements)) {
      throw new Error(`intent "${intentId}" field "${field}" must be an array`);
    }
    for (const statement of statements) push(kind, statement);
  }

  const written = record.requirements ?? [];
  if (!Array.isArray(written)) {
    throw new Error(`intent "${intentId}" field "requirements" must be an array`);
  }
  for (const entry of written) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`intent "${intentId}" has a malformed requirements entry`);
    }
    push(entry.kind, entry.statement, entry.id);
  }

  return requirements;
}

// Normalizes any accepted source (parsed JSON file — input shape or the
// written output shape — or flags already collected into the same shape)
// into the exact rows to insert. Throws on missing required fields —
// id/goal/outcome are NOT NULL in the schema.
//
// Idempotent: normalizeIntent(normalizeIntent(x)) deep-equals
// normalizeIntent(x). The replay path depends on that.
export function normalizeIntent(record) {
  const { id, goal, outcome, priority, depends_on: dependsOn } = record;

  if (!id) throw new Error('intent requires an id');
  if (!goal) throw new Error('intent requires a goal');
  if (!outcome) throw new Error('intent requires an outcome');

  const requirements = collectRequirements(record, id);

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

const prepareInsertIntent = (db) =>
  db.prepare(`
    INSERT INTO intents (id, goal, outcome, priority)
    VALUES (?, ?, ?, ?)
  `);

const prepareInsertRequirement = (db) =>
  db.prepare(`
    INSERT INTO requirements (id, intent_id, kind, statement)
    VALUES (?, ?, ?, ?)
  `);

const prepareInsertIntentDependency = (db) =>
  db.prepare(`
    INSERT INTO intent_dependencies (intent_id, depends_on_intent_id)
    VALUES (?, ?)
  `);

// The INSERT statements themselves, with no transaction of their own, so
// a caller that needs the file write inside the same transaction can
// supply one. Every constraint that matters here — the intents PRIMARY
// KEY, the requirements/intent_dependencies FOREIGN KEYs, the kind CHECK
// — is immediate, not deferred, so a bad record fails on the offending
// statement rather than at COMMIT. That's what lets addIntent below treat
// "the inserts returned" as "the DB accepted this intent".
function runIntentInserts(db, intent) {
  const runInsertIntent = prepareInsertIntent(db);
  const runInsertRequirement = prepareInsertRequirement(db);
  const runInsertDependency = prepareInsertIntentDependency(db);

  runInsertIntent.run(intent.id, intent.goal, intent.outcome, intent.priority);
  for (const r of intent.requirements) {
    runInsertRequirement.run(r.id, intent.id, r.kind, r.statement);
  }
  for (const dependsOnId of intent.depends_on) {
    runInsertDependency.run(intent.id, dependsOnId);
  }
}

// Writes a normalized intent's rows to `db` — one `intents` row, one
// `requirements` row per rule/constraint/acceptance item, one
// `intent_dependencies` row per depends_on entry — in one transaction,
// and touches no files. This is the whole of what a rebuild needs: a
// replay reconstructs the derived DB from the permanent record and has
// no business writing that record back out.
export function insertIntentRows(db, intent) {
  db.exec('BEGIN IMMEDIATE');
  try {
    runIntentInserts(db, intent);
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

// Reads the intent file already on disk, if any. Returns null when the
// file is absent; an unparseable file is also treated as "nothing to
// protect" only for the count — the guard below still refuses to touch
// it, since silently replacing a file we can't read is the same class of
// mistake as emptying one we can.
async function readExistingIntentFile(intentId, intentsDir) {
  let text;
  try {
    text = await readFile(intentFilePath(intentId, intentsDir), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return { text, record: JSON.parse(text) };
  } catch {
    return { text, record: null };
  }
}

// The safety net. An intent file is a committed, permanent record; a
// write that would take it from N requirements to zero is data loss, not
// an update. Refuse it and say so, rather than leave the caller to
// discover the loss in a later `git diff`.
export async function assertNonDestructiveWrite(intent, intentsDir = INTENTS_DIR) {
  const existing = await readExistingIntentFile(intent.id, intentsDir);
  if (existing === null) return;

  if (existing.record === null) {
    throw new Error(
      `refusing to overwrite ${intentFilePath(intent.id, intentsDir)}: ` +
        `the existing file is not valid JSON, so it can't be checked for data loss. ` +
        `Inspect or remove it by hand first.`,
    );
  }

  const existingCount = Array.isArray(existing.record.requirements)
    ? existing.record.requirements.length
    : 0;
  if (existingCount > 0 && intent.requirements.length === 0) {
    throw new Error(
      `refusing to overwrite ${intentFilePath(intent.id, intentsDir)}: ` +
        `it holds ${existingCount} requirement(s) and the new record has none. ` +
        `An intent file is the permanent record — emptying it would lose committed planning. ` +
        `If this is intentional, delete the file explicitly first.`,
    );
  }
}

// Writes the normalized intent to INTENTS_DIR/<id>.json, guarded against
// emptying an existing record.
//
// Written to a sibling temp file and renamed into place: `rename(2)` is
// atomic within a directory, so a crash or a full disk mid-write can
// never leave a half-written intent behind. That matters more than usual
// here, because assertNonDestructiveWrite refuses to overwrite a file it
// can't parse — a truncated record would otherwise be its own dead end.
export async function writeIntentFile(intent, intentsDir = INTENTS_DIR) {
  await assertNonDestructiveWrite(intent, intentsDir);
  await mkdir(intentsDir, { recursive: true });

  const finalPath = intentFilePath(intent.id, intentsDir);
  const tempPath = `${finalPath}.tmp-${process.pid}`;
  try {
    await writeFile(tempPath, JSON.stringify(intent, null, 2));
    await rename(tempPath, finalPath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  return intent;
}

// Writes a normalized intent (see normalizeIntent) to `db` AND to
// INTENTS_DIR/<id>.json, atomically with respect to the DB: the file
// write happens INSIDE the open transaction, immediately before COMMIT.
//
// The ordering is load-bearing in both directions:
//
//   * The inserts run first, so a record the DB will reject (duplicate
//     id, unknown depends_on) never reaches the file. The original bug
//     was the opposite order — write, then insert — which meant every
//     failed insert had already rewritten the permanent record, and
//     because normalizeIntent didn't round-trip, rewritten to empty.
//   * The write happens before COMMIT, so a write that fails rolls the
//     inserts back. Otherwise the mirror-image failure appears: the
//     intent exists only in the derived, gitignored DB, the command
//     reports failure, a retry hits the PRIMARY KEY constraint, and a
//     rebuild can't recover it because it was never in the permanent
//     record. Both halves land or neither does.
//
// The only remaining failure — COMMIT itself failing after the file
// landed — leaves the file without the row, which is the recoverable
// direction: the file IS the source of truth, and `db rebuild` replays
// it. A retry is fine too, since re-writing an identical record passes
// the guard.
//
// This does hold the write transaction open across one small file write.
// That's a sub-millisecond window against a 10s busy_timeout, and it buys
// the invariant that the DB never holds an intent the permanent record
// doesn't.
export async function addIntent(db, record, { intentsDir = INTENTS_DIR } = {}) {
  const intent = normalizeIntent(record);

  // Read-only, so a refusal costs nothing and needn't open a transaction.
  await assertNonDestructiveWrite(intent, intentsDir);

  db.exec('BEGIN IMMEDIATE');
  try {
    runIntentInserts(db, intent);
    await writeIntentFile(intent, intentsDir);
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
