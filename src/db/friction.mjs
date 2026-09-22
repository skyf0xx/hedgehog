// `hedgehog friction add`/`hedgehog friction list` — writes and reads the
// `friction` table. See hedgehog-persistent-build-graph.md, Schema, and
// src/skills/hedgehog-loop/SKILL.md's Friction log section.
//
// Every entry is also appended to FRICTION_LOG_PATH — a friction log you
// can't read in a PR is one nobody reads, and the DB is a derived
// artifact (rebuildable via `hedgehog db rebuild`) that can't be diffed
// in review the way a plain-text log can.

import { mkdir, appendFile } from 'node:fs/promises';

export const FRICTION_DIR = '.hedgehog/friction';
export const FRICTION_LOG_PATH = `${FRICTION_DIR}/log.md`;

const insertFriction = (db) =>
  db.prepare(`
    INSERT INTO friction (task_id, note)
    VALUES (?, ?)
  `);

// Writes one friction row. `taskId` is optional (the schema's task_id is
// nullable) — a reviewed-marker row (see tweaker.md) has no task_id.
export async function addFriction(db, { note, taskId }) {
  if (!note) throw new Error('friction requires a note');
  const result = insertFriction(db).run(taskId ?? null, note);
  const entry = { id: Number(result.lastInsertRowid), taskId: taskId ?? null, note };

  await mkdir(FRICTION_DIR, { recursive: true });
  const header = `## ${new Date().toISOString()}${taskId ? ` ${taskId}` : ''}`;
  await appendFile(FRICTION_LOG_PATH, `${header}\n\n${note}\n\n`);

  return entry;
}

// Returns every friction row, oldest first, for tweaker's review pass.
// Resolved rows are excluded by default — same convention as
// listDebt — and included when `includeResolved` is set (`--all`).
export function listFriction(db, { includeResolved = false } = {}) {
  const where = includeResolved ? '' : 'WHERE resolved_at IS NULL';
  return db
    .prepare(
      `SELECT id, task_id AS taskId, note, logged_at AS loggedAt,
              resolved_at AS resolvedAt, resolved_reason AS resolvedReason
       FROM friction ${where} ORDER BY id ASC`,
    )
    .all();
}

// Resolves one friction row by id: marks it resolved in the DB and
// appends the marker to the same committed log (FRICTION_LOG_PATH) the
// original entry was written to — friction has no `.hedgehog/notes/`
// record the way debt does, so this is the row's only committed source
// and `db rebuild` leaves friction rows untouched (see rebuild.mjs).
export async function resolveFriction(db, { frictionId, reason }) {
  if (!frictionId) throw new Error('friction resolve requires a friction id');
  if (!reason) throw new Error('friction resolve requires a --reason');

  const row = db
    .prepare('SELECT id, task_id AS taskId, note, resolved_at AS resolvedAt FROM friction WHERE id = ?')
    .get(frictionId);
  if (!row) throw new Error(`no such friction entry: #${frictionId}`);
  if (row.resolvedAt) throw new Error(`friction #${frictionId} is already resolved`);

  const resolvedAt = new Date().toISOString();
  db.prepare('UPDATE friction SET resolved_at = ?, resolved_reason = ? WHERE id = ?').run(
    resolvedAt,
    reason,
    frictionId,
  );

  await mkdir(FRICTION_DIR, { recursive: true });
  const header = `## ${resolvedAt} resolved #${frictionId}${row.taskId ? ` ${row.taskId}` : ''}`;
  await appendFile(FRICTION_LOG_PATH, `${header}\n\n${reason}\n\n`);

  return { id: row.id, taskId: row.taskId, note: row.note, resolvedAt, resolvedReason: reason };
}
