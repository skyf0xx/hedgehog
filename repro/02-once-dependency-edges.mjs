// Dependency edges resolve in both directions across the cardinality
// boundary:
//
//   per-module → once   every module's `schema` waits on the single
//                       `CLUSTER`, so one head infra task gates the whole
//                       build instead of one per module
//   once → per-module   the single `DEPLOY` waits on *every* module's
//                       `api`, so it ships only after all of them landed
//
// Against the pre-cardinality compiler this fails: each module gets its
// own USERS-CLUSTER / USERS-DEPLOY and the edges never cross modules.

import { makeProject, addIntent, cli, edgesInto, cleanup, check, report, ONCE_CORE } from './_lib.mjs';

const dir = makeProject(ONCE_CORE);
try {
  for (const id of ['users', 'orders', 'billing']) addIntent(dir, id);
  check('plan exits 0', 0, cli(dir, ['plan']).status);

  check('CLUSTER depends on nothing (chain head)', [], edgesInto(dir, 'CLUSTER'));

  for (const module of ['USERS', 'ORDERS', 'BILLING']) {
    check(
      `${module}-SCHEMA waits on the single CLUSTER`,
      ['CLUSTER'],
      edgesInto(dir, `${module}-SCHEMA`),
    );
    check(
      `${module}-API waits on its own module's schema only`,
      [`${module}-SCHEMA`],
      edgesInto(dir, `${module}-API`),
    );
  }

  check(
    'DEPLOY waits on every module\'s api',
    ['BILLING-API', 'ORDERS-API', 'USERS-API'],
    edgesInto(dir, 'DEPLOY'),
  );
} finally {
  cleanup(dir);
}

report('02 — once-layer edges resolve in both directions');
