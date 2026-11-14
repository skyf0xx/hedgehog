// `.hedgehog/hedgehog.db` is gitignored, so friction that lived only in
// the DB was gone after a fresh clone, a deleted DB, or a merged-back
// worktree, and `friction list` came back empty. Each `friction add` and
// `friction resolve` writes a committed record under `.hedgehog/friction/`,
// and `db rebuild` replays it, open and resolved alike.
//
// A row that exists only in the DB (logged before records existed) must
// survive too: `db rebuild` carries it across as it is, and the next
// `friction list` writes it a record, after which it survives a rebuild
// from a deleted DB.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeProject,
  addIntent,
  cli,
  openGraph,
  rebuildFromScratch,
  cleanup,
  check,
  checkContains,
  report,
  ONCE_CORE,
} from './_lib.mjs';

const frictionRows = (dir) => {
  const db = openGraph(dir);
  try {
    return db
      .prepare('SELECT task_id, note, resolved_reason FROM friction ORDER BY logged_at, note')
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
};

const recordCount = (dir) =>
  readdirSync(join(dir, '.hedgehog/friction')).filter((n) => n.endsWith('.json')).length;

const dir = makeProject(ONCE_CORE, { git: true });
try {
  addIntent(dir, 'task');
  check('plan exits 0', 0, cli(dir, ['plan']).status);

  check('friction add (task) exits 0', 0, cli(dir, ['friction', 'add', 'pool gap', '--task', 'CLUSTER']).status);
  check('friction add (no task) exits 0', 0, cli(dir, ['friction', 'add', 'docs unclear']).status);
  check(
    'friction resolve exits 0',
    0,
    cli(dir, ['friction', 'resolve', '2', '--reason', 'filed upstream']).status,
  );
  check('one record per friction entry', 2, recordCount(dir));

  const expected = [
    { task_id: 'CLUSTER', note: 'pool gap', resolved_reason: null },
    { task_id: null, note: 'docs unclear', resolved_reason: 'filed upstream' },
  ];

  check('db rebuild from a deleted DB exits 0', 0, rebuildFromScratch(dir).status);
  check('open and resolved friction survive a rebuild from a deleted DB', expected, frictionRows(dir));

  const listed = cli(dir, ['friction', 'list']);
  checkContains('friction list shows the open entry', listed.stdout, 'pool gap');
  check(
    'friction list leaves the resolved entry out',
    false,
    listed.stdout.includes('docs unclear'),
  );

  // A row from before records existed: in the DB, with no file behind it.
  const db = openGraph(dir);
  try {
    db.prepare("INSERT INTO friction (task_id, note, logged_at) VALUES ('CLUSTER', 'legacy row', '2020-01-01 00:00:00')").run();
  } finally {
    db.close();
  }

  check('db rebuild exits 0', 0, cli(dir, ['db', 'rebuild']).status);
  check(
    'a DB-only row is carried across a rebuild of the same DB',
    true,
    frictionRows(dir).some((row) => row.note === 'legacy row' && row.task_id === 'CLUSTER'),
  );

  check('friction list exits 0', 0, cli(dir, ['friction', 'list']).status);
  check('friction list wrote a record for the DB-only row', 3, recordCount(dir));
  check('a second friction list writes nothing more', 3, (cli(dir, ['friction', 'list']), recordCount(dir)));

  check('db rebuild from a deleted DB exits 0', 0, rebuildFromScratch(dir).status);
  check(
    'the backfilled row survives a rebuild from a deleted DB',
    [{ task_id: 'CLUSTER', note: 'legacy row', resolved_reason: null }, ...expected],
    frictionRows(dir),
  );
} finally {
  cleanup(dir);
}

report('friction, open and resolved, survives a rebuild from a deleted DB');
