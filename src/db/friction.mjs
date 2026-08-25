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
export function listFriction(db) {
  return db
    .prepare(`SELECT id, task_id AS taskId, note, logged_at AS loggedAt FROM friction ORDER BY id ASC`)
    .all();
}

// Correlates friction onto the files the friction-carrying tasks
// actually reach, via each task's `context_files` (the blast-radius file
// set plan.mjs resolves at compile). Two notes on tasks whose radii
// overlap on one file are evidence of a single underlying gap, which is
// the grouping call tweaker makes by hand from the notes' wording alone.
//
// Returns { hotspots, uncorrelated }: hotspots as
// [{ path, frictionCount, taskIds }] sorted by frictionCount descending,
// uncorrelated the count of notes that reached no file. Both halves ship
// together because a hotspot list is only readable against how much of
// the log it covers — three correlated notes out of twenty, reported as
// three, is worse than reporting nothing.
//
// Rows with a NULL task_id (a reviewed-marker row, see tweaker.md) trace
// to no task and carry no radius, so they are neither correlated nor
// counted as uncorrelated. Rows whose task has NULL `context_files` —
// every task on a project with no index — are the uncorrelated total.
//
// Wrapped the way status.mjs#countFriction is: a build graph predating
// the `friction` table throws on the read, and `status` is the command
// every session starts with.
export function frictionByModule(db) {
  try {
    const rows = db
      .prepare(`
        SELECT f.id AS id, f.task_id AS taskId, t.context_files AS contextFiles
        FROM friction f
        JOIN tasks t ON t.id = f.task_id
        WHERE f.task_id IS NOT NULL
        ORDER BY f.id ASC
      `)
      .all();

    let uncorrelated = 0;
    // Per path, the distinct tasks whose radius reaches it — a task with
    // two notes counts twice, so frictionCount is over notes, not tasks.
    const byPath = new Map();

    for (const { taskId, contextFiles } of rows) {
      // Falsy covers both NULL and the `undefined` a read-only handle
      // returns on a graph that never migrated the column in.
      const paths = contextFiles ? parseContextFiles(contextFiles) : null;
      if (!paths || paths.length === 0) {
        uncorrelated += 1;
        continue;
      }
      for (const path of new Set(paths)) {
        const entry = byPath.get(path) ?? { path, frictionCount: 0, taskIds: [] };
        entry.frictionCount += 1;
        if (!entry.taskIds.includes(taskId)) entry.taskIds.push(taskId);
        byPath.set(path, entry);
      }
    }

    const hotspots = [...byPath.values()].sort(
      (a, b) => b.frictionCount - a.frictionCount || a.path.localeCompare(b.path),
    );
    return { hotspots, uncorrelated };
  } catch {
    return { hotspots: [], uncorrelated: 0 };
  }
}

// `context_files` is a JSON array of repo-relative paths. A row written
// by a provider that returned something else is worth no more than an
// absent one, so anything unparseable or non-array reads as no files.
function parseContextFiles(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : null;
  } catch {
    return null;
  }
}
