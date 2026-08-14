// A rebuild's result is a pure function of the committed sources, not of
// the sources plus whatever the DB already held.
//
// The scenario is correcting an intent id: rename
// `.hedgehog/intents/task.json` to `tasks.json`, change the id inside it,
// and rebuild. Replaying additively leaves the old `TASK-*` tasks behind
// — their intent file no longer exists, but nothing deletes them — and
// the scheduler then correctly holds the real `TASKS-SCHEMA` back behind
// a ghost `TASK-SCHEMA` whose scope overlaps it. The graph that results
// is one no set of committed intents describes.
//
// Operator-recorded notes are the deliberate exception: `debt` and
// `friction` have no committed source to replay from, so they are carried
// across the clear by task id and only reported as orphaned when the
// recompiled graph has no such task.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeProject,
  addIntent,
  cli,
  openGraph,
  taskIds,
  cleanup,
  check,
  checkContains,
  report,
  ONCE_CORE,
} from './_lib.mjs';

const dir = makeProject(ONCE_CORE, { git: true });
try {
  addIntent(dir, 'task');
  check('plan exits 0', 0, cli(dir, ['plan']).status);
  check(
    'the singular id compiled TASK-* tasks',
    true,
    taskIds(dir).some((id) => id.startsWith('TASK-')),
  );

  // Notes the operator recorded against a task that survives the rename
  // (CLUSTER is a once-layer, so it is not module-derived), and against
  // one that does not (TASK-SCHEMA vanishes with the corrected id).
  check(
    'debt add on a surviving task exits 0',
    0,
    cli(dir, ['debt', 'add', 'CLUSTER', 'inherited pg pool gap']).status,
  );
  check(
    'debt add on a vanishing task exits 0',
    0,
    cli(dir, ['debt', 'add', 'TASK-SCHEMA', 'title length is hand-corrected']).status,
  );
  check(
    'friction add exits 0',
    0,
    cli(dir, ['friction', 'add', 'module axis is plural', '--task', 'TASK-SCHEMA']).status,
  );

  // Correct the id at the committed source, the way the docs direct.
  const intentPath = join(dir, '.hedgehog/intents/task.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  intent.id = 'tasks';
  for (const requirement of intent.requirements ?? []) {
    requirement.id = requirement.id.replace(/^TASK-/, 'TASKS-');
  }
  writeFileSync(intentPath, JSON.stringify(intent, null, 2));
  renameSync(intentPath, join(dir, '.hedgehog/intents/tasks.json'));

  const rebuilt = cli(dir, ['db', 'rebuild']);
  check('db rebuild exits 0', 0, rebuilt.status);

  const ids = taskIds(dir);
  check(
    'no task survives from the intent file that no longer exists',
    [],
    ids.filter((id) => id.startsWith('TASK-')),
  );
  check(
    'the corrected id compiled TASKS-* tasks',
    true,
    ids.some((id) => id.startsWith('TASKS-')),
  );

  // A note whose task is gone is reported rather than disappearing.
  checkContains('the orphaned debt note is reproduced', rebuilt.stdout, 'title length is hand-corrected');

  const db = openGraph(dir);
  try {
    check(
      'the debt note on a surviving task is carried across, re-attached',
      [{ task_id: 'CLUSTER', note: 'inherited pg pool gap' }],
      db.prepare('SELECT task_id, note FROM debt').all(),
    );
    check(
      'the friction note survives unattached rather than being lost',
      [{ task_id: null, note: 'module axis is plural' }],
      db.prepare('SELECT task_id, note FROM friction').all(),
    );
  } finally {
    db.close();
  }
} finally {
  cleanup(dir);
}

report('db rebuild replaces the derived graph instead of replaying onto it');
