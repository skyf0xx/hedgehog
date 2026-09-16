// `hedgehog debt add` / `hedgehog debt list` — declared debt between
// tasks. See schema.mjs's `debt` table and next.mjs's INHERITED DEBT
// packet section.
//
// A layer that discovers a real limitation while building — something the
// next layer down the chain has to compensate for — has no way to tell
// that layer. A "KNOWN LIMITATION" comment in a source file is not a
// mechanism: the inheriting task's packet is assembled from the graph,
// not from reading its dependencies' comments, so the note never
// arrives. `debt add` records the note against the declaring task, and
// next.mjs renders it into the packet of every task that depends on it.
//
// A note recorded here has a committed source behind it —
// `.hedgehog/notes/<task-id>.json` (notes.mjs) — the same way
// `.hedgehog/reconciled/*.json` backs a reconciliation. Debt is in-build
// traffic between two tasks, and a file under `.hedgehog/` written
// mid-task sits outside every task's scope globs — it would trip verify's
// scope gate on the very task that declared it — so `hedgehog debt add`
// writes it directly rather than through the declaring task's own commit.
// `hedgehog db rebuild` replays it from there (rebuild.mjs), the same way
// it replays overrides and reconciliations.

import { applySchema } from './schema.mjs';
import { appendNote } from './notes.mjs';

const insertDebt = (db) =>
  db.prepare(`
    INSERT INTO debt (task_id, note, logged_at)
    VALUES (?, ?, ?)
  `);

function taskExists(db, taskId) {
  return db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId) !== undefined;
}

// Writes one debt row against `taskId`, and its committed record. The
// task must exist — debt addressed to nobody reaches nobody, and the
// schema's foreign key would reject it anyway, less legibly.
//
// Committed file before DB row, deliberately — reconcile.mjs's same
// ordering, for the same reason: if the write fails, nothing has been
// recorded on a fact that would not survive the next rebuild.
export async function addDebt(db, { taskId, note }, notesDir = undefined) {
  // Idempotent, and the migration path for a build graph created before
  // the `debt` table existed: dbInit only applies the schema to a DB it
  // just created, so an in-flight project's DB would otherwise have no
  // table to insert into.
  applySchema(db);

  if (!taskId) throw new Error('debt requires a task id');
  if (!note) throw new Error('debt requires a note');
  if (!taskExists(db, taskId)) throw new Error(`no such task: ${taskId}`);

  const loggedAt = new Date().toISOString();
  await appendNote(taskId, { kind: 'debt', note, loggedAt }, notesDir);

  const result = insertDebt(db).run(taskId, note, loggedAt);
  return { id: Number(result.lastInsertRowid), taskId, note };
}

// Every debt row, oldest first, optionally narrowed to one task. Resolved
// rows are excluded by default — `debt list` is meant to answer "what's
// still open", the same way `reconcile list` never re-surfaces a task once
// it has closed — and included when `includeResolved` is set (`--all`).
export function listDebt(db, taskId, { includeResolved = false } = {}) {
  const conditions = [];
  const params = [];
  if (taskId) {
    conditions.push('task_id = ?');
    params.push(taskId);
  }
  if (!includeResolved) conditions.push('resolved_at IS NULL');
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    return db
      .prepare(
        `SELECT id, task_id AS taskId, note, logged_at AS loggedAt,
                resolved_at AS resolvedAt, resolved_reason AS resolvedReason
         FROM debt ${where} ORDER BY id ASC`,
      )
      .all(...params);
  } catch {
    // No `debt` table yet (a build graph from before this table existed).
    return [];
  }
}

// Count of open (unresolved) debt across the whole graph — the one-line
// figure `hedgehog next`/`hedgehog claim` surface so debt doesn't
// accumulate silently with nothing prompting a look at it.
export function openDebtCount(db) {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM debt WHERE resolved_at IS NULL').get();
    return row.n;
  } catch {
    return 0;
  }
}

// Resolves one debt row by id: marks it resolved in the DB and writes the
// committed record behind it — same ordering as addDebt (file before row)
// and the same reason: if the write fails, nothing has been resolved on a
// fact that would not survive the next rebuild.
//
// The committed note is keyed by the debt row's own (task_id, note,
// logged_at) rather than its DB `id`, because that id is a fresh
// autoincrement every time rebuild.mjs#replayNotes re-inserts debt rows —
// it is not stable across a rebuild, so a resolution referencing it would
// point at nothing once replayed. The triple already committed for the
// debt note itself is the one part of its identity that *is* stable.
export async function resolveDebt(db, { debtId, reason }, notesDir = undefined) {
  applySchema(db);

  if (!debtId) throw new Error('debt resolve requires a debt id');
  if (!reason) throw new Error('debt resolve requires a --reason');

  const row = db
    .prepare('SELECT id, task_id AS taskId, note, logged_at AS loggedAt, resolved_at AS resolvedAt FROM debt WHERE id = ?')
    .get(debtId);
  if (!row) throw new Error(`no such debt: #${debtId}`);
  if (row.resolvedAt) throw new Error(`debt #${debtId} is already resolved`);

  const resolvedAt = new Date().toISOString();
  await appendNote(
    row.taskId,
    { kind: 'debt-resolve', resolves: row.loggedAt, reason, loggedAt: resolvedAt },
    notesDir,
  );

  db.prepare('UPDATE debt SET resolved_at = ?, resolved_reason = ? WHERE id = ?').run(
    resolvedAt,
    reason,
    debtId,
  );

  return { id: row.id, taskId: row.taskId, note: row.note, resolvedAt, resolvedReason: reason };
}
