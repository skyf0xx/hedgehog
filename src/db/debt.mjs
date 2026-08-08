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
// Unlike friction.mjs, nothing is written to a committed markdown log.
// Debt is in-build traffic between two tasks, and a file under
// `.hedgehog/` written mid-task sits outside every task's scope globs —
// it would trip verify's scope gate on the very task that declared it.
// The consequence is that debt does not survive `hedgehog db rebuild`
// (which replays only `.hedgehog/intents/*.json`); by then the
// inheriting task has usually already consumed it.

import { applySchema } from './schema.mjs';

const insertDebt = (db) =>
  db.prepare(`
    INSERT INTO debt (task_id, note)
    VALUES (?, ?)
  `);

function taskExists(db, taskId) {
  return db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId) !== undefined;
}

// Writes one debt row against `taskId`. The task must exist — debt
// addressed to nobody reaches nobody, and the schema's foreign key would
// reject it anyway, less legibly.
export function addDebt(db, { taskId, note }) {
  // Idempotent, and the migration path for a build graph created before
  // the `debt` table existed: dbInit only applies the schema to a DB it
  // just created, so an in-flight project's DB would otherwise have no
  // table to insert into.
  applySchema(db);

  if (!taskId) throw new Error('debt requires a task id');
  if (!note) throw new Error('debt requires a note');
  if (!taskExists(db, taskId)) throw new Error(`no such task: ${taskId}`);

  const result = insertDebt(db).run(taskId, note);
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
