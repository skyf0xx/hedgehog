#!/usr/bin/env node
// Piece 1 of hedgehog-code-intelligence-recommendation.md: an existing
// .hedgehog/hedgehog.db predating the three context columns must pick
// them up on the next writable open, via ensureTaskColumns — not just on
// a fresh `db init`. Simulates "old DB" by dropping the columns directly
// (node:sqlite supports ALTER TABLE ... DROP COLUMN), confirms `next`
// still renders correctly with them gone, then drives a write command
// (`hedgehog claim`, which calls ensureTaskColumns per claim.mjs:262)
// and confirms the columns are back.

import { DatabaseSync } from 'node:sqlite';
import {
  assert,
  assertExcludes,
  assertIncludes,
  hedgehog,
  makeProject,
  readTask,
  runRepro,
} from './lib.mjs';

await runRepro('code intelligence: old DB migrates via ensureTaskColumns', async () => {
  const { dir, dbPath, cleanup } = await makeProject();
  try {
    // Drop the three columns to simulate a DB created before this
    // feature shipped.
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('ALTER TABLE tasks DROP COLUMN context_symbols');
      db.exec('ALTER TABLE tasks DROP COLUMN context_files');
      db.exec('ALTER TABLE tasks DROP COLUMN context_indexed_at');
      const columns = db.prepare('PRAGMA table_info(tasks)').all().map((r) => r.name);
      assert(!columns.includes('context_files'), 'expected context_files dropped before migration');
    } finally {
      db.close();
    }

    // Between the drop and the migrating write, `next` must still work —
    // a missing column reads back as undefined, and undefined must be
    // treated as falsy the same way NULL is, so no PRE-READ section and
    // no crash.
    const nextBefore = hedgehog(dir, ['next']);
    assertIncludes(nextBefore.out, 'ALLOWED SCOPE', 'expected next to render normally without the columns');
    assertExcludes(nextBefore.out, 'PRE-READ', 'expected no PRE-READ section while the columns are missing');

    // A write path — claim — calls ensureTaskColumns before touching
    // tasks, so this is what brings the columns back.
    const claimed = hedgehog(dir, ['claim', '--owner', 'ag1']);
    assertIncludes(claimed.out, 'ALPHA-SCHEMA', 'expected claim to hand out the ready task');

    const dbAfter = new DatabaseSync(dbPath, { readOnly: true });
    let columnsAfter;
    try {
      columnsAfter = dbAfter.prepare('PRAGMA table_info(tasks)').all().map((r) => r.name);
    } finally {
      dbAfter.close();
    }
    for (const name of ['context_symbols', 'context_files', 'context_indexed_at']) {
      assert(columnsAfter.includes(name), `expected ${name} restored by ensureTaskColumns`);
    }

    const task = readTask(dbPath, 'ALPHA-SCHEMA');
    assert(task.status === 'building', `expected ALPHA-SCHEMA claimed into building, got ${task.status}`);
    assert(task.context_files === null, `expected context_files NULL after migration, got ${task.context_files}`);

    // ALPHA-SCHEMA is now building, not ready, so `next` moves on to
    // whatever's next in the readiness SELECT (nothing, here — the
    // service layer depends on schema). Rendering without a crash on a
    // fully-restored-but-still-NULL-context graph is the point.
    const nextAfter = hedgehog(dir, ['next']);
    assertIncludes(nextAfter.out, 'No ready task', 'expected next to render cleanly post-migration with no PRE-READ');
  } finally {
    await cleanup();
  }
});
