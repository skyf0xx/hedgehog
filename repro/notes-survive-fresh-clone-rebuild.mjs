// The bug this fixes: `debt` and `decisions` rows had no committed
// source, so `hedgehog db rebuild`'s carry-across only worked because it
// always ran against the one DB that already held them
// (rebuild.mjs#clearDerivedGraph, before notes.mjs existed). Deleting the
// DB file entirely — the fresh-clone case, and the shape a merged-back
// git worktree's own separate DB is in — left nothing for a rebuild to
// carry across, and every debt/decision note vanished silently.
//
// `debt add` / `decision add` now write a committed record
// (`.hedgehog/notes/<task-id>.json`, notes.mjs) before touching the DB,
// and `hedgehog db rebuild` replays from that file. This reproduction
// deletes the DB outright (not just its rows) and checks the notes come
// back — the scenario deleting rows and rebuilding on top could not have
// caught.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeProject,
  addIntent,
  cli,
  openGraph,
  rebuildFromScratch,
  cleanup,
  check,
  report,
  ONCE_CORE,
} from './_lib.mjs';

const dir = makeProject(ONCE_CORE, { git: true });
try {
  addIntent(dir, 'task');
  check('plan exits 0', 0, cli(dir, ['plan']).status);

  check(
    'debt add exits 0',
    0,
    cli(dir, ['debt', 'add', 'CLUSTER', 'inherited pg pool gap']).status,
  );
  check(
    'decision add exits 0',
    0,
    cli(dir, ['decision', 'add', 'CLUSTER', 'chose managed postgres over self-hosted']).status,
  );

  const notesFile = JSON.parse(
    readFileSync(join(dir, '.hedgehog/notes/cluster.json'), 'utf8'),
  );
  check(
    'debt add wrote a committed record before touching the DB',
    [
      { kind: 'debt', note: 'inherited pg pool gap' },
      { kind: 'decision', note: 'chose managed postgres over self-hosted' },
    ],
    notesFile.notes.map(({ kind, note }) => ({ kind, note })),
  );

  // The fresh-clone / merged-worktree case: the DB file itself is gone,
  // not just its rows — there is nothing for an in-DB carry-across to
  // read from.
  const rebuilt = rebuildFromScratch(dir);
  check('db rebuild exits 0', 0, rebuilt.status);

  const db = openGraph(dir);
  try {
    check(
      'the debt note survives a rebuild from a deleted DB',
      [{ task_id: 'CLUSTER', note: 'inherited pg pool gap' }],
      db.prepare('SELECT task_id, note FROM debt').all(),
    );
    check(
      'the decision note survives a rebuild from a deleted DB',
      [{ task_id: 'CLUSTER', note: 'chose managed postgres over self-hosted' }],
      db.prepare('SELECT task_id, note FROM decisions').all(),
    );
  } finally {
    db.close();
  }
} finally {
  cleanup(dir);
}

report('debt and decision notes survive a rebuild from a deleted DB, not just cleared rows');
