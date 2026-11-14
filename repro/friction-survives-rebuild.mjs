// `.hedgehog/hedgehog.db` is gitignored, so friction must have a committed
// source to outlive a fresh clone or a deleted DB. Each `friction add` and
// `friction resolve` writes a record under `.hedgehog/friction/`, and
// `db rebuild` replays it, open and resolved alike.
//
// A DB row in SQLite's `datetime('now')` form with no record survives
// `db rebuild` as it is, and the next `friction list` writes it a record.
// An ISO row with no record is a deleted record: rebuild drops it rather
// than bringing it back, and an edited record replaces its old row rather
// than adding a second one. Ordering compares times, not strings, across
// both timestamp forms.

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const frictionDir = (dir) => join(dir, '.hedgehog/friction');

const frictionRows = (dir) => {
  const db = openGraph(dir);
  try {
    return db
      .prepare('SELECT task_id, note, resolved_reason FROM friction ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
};

const recordFiles = (dir) => readdirSync(frictionDir(dir)).filter((n) => n.endsWith('.json'));

const recordFor = (dir, note) =>
  recordFiles(dir).find((name) => JSON.parse(readFileSync(join(frictionDir(dir), name), 'utf8')).note === note);

const insertRow = (dir, note, loggedAt) => {
  const db = openGraph(dir);
  try {
    db.prepare('INSERT INTO friction (task_id, note, logged_at) VALUES (?, ?, ?)').run('CLUSTER', note, loggedAt);
  } finally {
    db.close();
  }
};

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
  check('one record per friction entry', 2, recordFiles(dir).length);

  const expected = [
    { task_id: 'CLUSTER', note: 'pool gap', resolved_reason: null },
    { task_id: null, note: 'docs unclear', resolved_reason: 'filed upstream' },
  ];

  check('db rebuild from a deleted DB exits 0', 0, rebuildFromScratch(dir).status);
  check('open and resolved friction survive a rebuild from a deleted DB', expected, frictionRows(dir));

  const listed = cli(dir, ['friction', 'list']);
  checkContains('friction list shows the open entry', listed.stdout, 'pool gap');
  check('friction list leaves the resolved entry out', false, listed.stdout.includes('docs unclear'));

  // A deleted record stays deleted.
  check('friction add exits 0', 0, cli(dir, ['friction', 'add', 'junk']).status);
  rmSync(join(frictionDir(dir), recordFor(dir, 'junk')));
  check('db rebuild exits 0', 0, cli(dir, ['db', 'rebuild']).status);
  check('a deleted record does not come back as a row', expected, frictionRows(dir));
  check('friction list exits 0', 0, cli(dir, ['friction', 'list']).status);
  check('a deleted record does not come back as a file', 2, recordFiles(dir).length);

  // An edited record replaces its row.
  const poolPath = join(frictionDir(dir), recordFor(dir, 'pool gap'));
  const pool = JSON.parse(readFileSync(poolPath, 'utf8'));
  writeFileSync(poolPath, JSON.stringify({ ...pool, note: 'pool size gap' }, null, 2));
  check('db rebuild exits 0', 0, cli(dir, ['db', 'rebuild']).status);
  expected[0] = { ...expected[0], note: 'pool size gap' };
  check('an edited record yields one row, not two', expected, frictionRows(dir));
  check('friction list exits 0', 0, cli(dir, ['friction', 'list']).status);
  check('an edited record yields no extra file', 2, recordFiles(dir).length);

  // A row with no record, in SQLite's own timestamp form.
  insertRow(dir, 'unrecorded row', '2020-01-01 00:00:00');
  check('db rebuild exits 0', 0, cli(dir, ['db', 'rebuild']).status);
  check(
    'a datetime-form row with no record is carried across a rebuild of the same DB',
    true,
    frictionRows(dir).some((row) => row.note === 'unrecorded row' && row.task_id === 'CLUSTER'),
  );
  check('friction list exits 0', 0, cli(dir, ['friction', 'list']).status);
  check('friction list wrote a record for that row', 3, recordFiles(dir).length);
  cli(dir, ['friction', 'list']);
  check('a second friction list writes nothing more', 3, recordFiles(dir).length);

  check('db rebuild from a deleted DB exits 0', 0, rebuildFromScratch(dir).status);
  check(
    'the row with its new record survives a rebuild from a deleted DB',
    [{ task_id: 'CLUSTER', note: 'unrecorded row', resolved_reason: null }, ...expected],
    frictionRows(dir),
  );

  // Ordering across timestamp forms: 09:00Z is earlier than 10:00 UTC.
  writeFileSync(
    join(frictionDir(dir), 'ordering.json'),
    JSON.stringify({ task: null, note: 'iso nine', logged_at: '2021-06-01T09:00:00.000Z', resolved_at: null, resolved_reason: null }),
  );
  insertRow(dir, 'sqlite ten', '2021-06-01 10:00:00');
  check('db rebuild exits 0', 0, cli(dir, ['db', 'rebuild']).status);
  const order = frictionRows(dir).map((row) => row.note);
  check(
    'a 09:00Z record sorts before a 10:00 datetime-form row',
    true,
    order.indexOf('iso nine') !== -1 && order.indexOf('iso nine') < order.indexOf('sqlite ten'),
  );
} finally {
  cleanup(dir);
}

report('friction, open and resolved, survives a rebuild; deleted and edited records are not resurrected');
