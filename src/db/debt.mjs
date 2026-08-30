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

// Every debt row, oldest first, optionally narrowed to one task.
export function listDebt(db, taskId) {
  const where = taskId ? 'WHERE task_id = ?' : '';
  const params = taskId ? [taskId] : [];
  try {
    return db
      .prepare(
        `SELECT id, task_id AS taskId, note, logged_at AS loggedAt FROM debt ${where} ORDER BY id ASC`,
      )
      .all(...params);
  } catch {
    // No `debt` table yet (a build graph from before this table existed).
    return [];
  }
}
