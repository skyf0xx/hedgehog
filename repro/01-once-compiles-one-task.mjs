// A `once: true` layer compiles exactly one task no matter how many
// intents the graph holds, while the per-module layers around it still
// compile one task each.
//
// Against the pre-cardinality compiler this fails: `compileIntentTasks`
// does `core.layers.map(...)` for every intent, so `cluster` and `deploy`
// compile three copies each — the measured cost this feature removes.

import { makeProject, addIntent, cli, tasksForLayer, cleanup, check, report, ONCE_CORE } from './_lib.mjs';

const dir = makeProject(ONCE_CORE);
try {
  for (const id of ['users', 'orders', 'billing']) addIntent(dir, id);
  const planned = cli(dir, ['plan']);
  check('plan exits 0', 0, planned.status);

  check(
    'cluster (once) compiles one task, with no intent prefix',
    [{ id: 'CLUSTER', module: '_core', intent_id: '_core' }],
    tasksForLayer(dir, 'cluster'),
  );

  check(
    'deploy (once) compiles one task',
    [{ id: 'DEPLOY', module: '_core', intent_id: '_core' }],
    tasksForLayer(dir, 'deploy'),
  );

  check(
    'schema (per-module) still compiles one task per intent',
    [
      { id: 'BILLING-SCHEMA', module: 'billing', intent_id: 'billing' },
      { id: 'ORDERS-SCHEMA', module: 'orders', intent_id: 'orders' },
      { id: 'USERS-SCHEMA', module: 'users', intent_id: 'users' },
    ],
    tasksForLayer(dir, 'schema'),
  );

  check(
    'api (per-module) still compiles one task per intent',
    [
      { id: 'BILLING-API', module: 'billing', intent_id: 'billing' },
      { id: 'ORDERS-API', module: 'orders', intent_id: 'orders' },
      { id: 'USERS-API', module: 'users', intent_id: 'users' },
    ],
    tasksForLayer(dir, 'api'),
  );
} finally {
  cleanup(dir);
}

report('01 — once layer compiles exactly one task');
