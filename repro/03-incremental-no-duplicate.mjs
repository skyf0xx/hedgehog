// Incremental compile: a fourth intent added after the first three were
// already compiled must not produce a second copy of a `once: true`
// layer. It must still be wired to the existing one — forwards (its
// schema waits on CLUSTER) and backwards (DEPLOY grows an edge onto its
// api).
//
// This also covers the skip check itself. `planTasks` decides an intent
// is already compiled by looking for `taskId(intent, core.layers[0])`.
// With a once-layer at the head that id is the same for every intent, so
// keying on it would make every intent after the first look
// already-compiled and silently compile nothing at all.

import { makeProject, addIntent, cli, tasksForLayer, edgesInto, taskIds, cleanup, check, report, ONCE_CORE } from './_lib.mjs';

const dir = makeProject(ONCE_CORE);
try {
  for (const id of ['users', 'orders', 'billing']) addIntent(dir, id);
  check('first plan exits 0', 0, cli(dir, ['plan']).status);

  check(
    'three intents compiled their per-module layers',
    ['BILLING-API', 'BILLING-SCHEMA', 'CLUSTER', 'DEPLOY', 'ORDERS-API', 'ORDERS-SCHEMA', 'USERS-API', 'USERS-SCHEMA'],
    taskIds(dir),
  );

  addIntent(dir, 'payments');
  const second = cli(dir, ['plan']);
  check('second plan exits 0', 0, second.status);

  check(
    'cluster is still a single task after the fourth intent',
    [{ id: 'CLUSTER', module: '_core', intent_id: '_core' }],
    tasksForLayer(dir, 'cluster'),
  );
  check(
    'deploy is still a single task after the fourth intent',
    [{ id: 'DEPLOY', module: '_core', intent_id: '_core' }],
    tasksForLayer(dir, 'deploy'),
  );

  check(
    'the fourth intent compiled its own per-module tasks',
    ['BILLING-API', 'BILLING-SCHEMA', 'CLUSTER', 'DEPLOY', 'ORDERS-API', 'ORDERS-SCHEMA', 'PAYMENTS-API', 'PAYMENTS-SCHEMA', 'USERS-API', 'USERS-SCHEMA'],
    taskIds(dir),
  );

  check(
    'the fourth module waits on the existing CLUSTER',
    ['CLUSTER'],
    edgesInto(dir, 'PAYMENTS-SCHEMA'),
  );

  check(
    'DEPLOY grew an edge onto the fourth module',
    ['BILLING-API', 'ORDERS-API', 'PAYMENTS-API', 'USERS-API'],
    edgesInto(dir, 'DEPLOY'),
  );
} finally {
  cleanup(dir);
}

report('03 — a later intent does not duplicate the once layer');
