// A tail `once: true` layer that has already completed must not stay
// complete when a later intent adds a new prerequisite under it.
//
// This is the Re-entry pass, which is a first-class flow: `planner` adds
// new scope to a finished build without disturbing what is built. With a
// tail once-layer like `deploy`, the new module's `api` becomes a
// prerequisite of the already-complete DEPLOY. Leaving DEPLOY complete
// means the new module can finish and the graph reports the whole build
// done while the build-wide deploy never ran for it.
//
// Two halves, because the live graph and the rebuilt graph can disagree:
//   A. `hedgehog plan` must reopen the completed once-task.
//   B. `hedgehog db rebuild` must not immediately re-close it from the
//      commit its earlier run left in history — otherwise the fix
//      evaporates on any fresh clone, which is exactly when a re-entry
//      pass tends to happen.

import {
  makeProject,
  addIntent,
  cli,
  commitTaskSubject,
  rebuildFromScratch,
  taskStatuses,
  edgesInto,
  cleanup,
  check,
  checkContains,
  report,
  ONCE_CORE,
} from './_lib.mjs';

const dir = makeProject(ONCE_CORE, { git: true });
try {
  for (const id of ['users', 'orders']) addIntent(dir, id);
  check('first plan exits 0', 0, cli(dir, ['plan']).status);

  // Build the whole thing out: every task's verify commit lands, exactly
  // as a finished build's history looks.
  for (const id of [
    'CLUSTER',
    'USERS-SCHEMA',
    'ORDERS-SCHEMA',
    'USERS-API',
    'ORDERS-API',
    'DEPLOY',
  ]) {
    commitTaskSubject(dir, id);
  }
  check('rebuild after the finished build exits 0', 0, rebuildFromScratch(dir).status);

  const finished = taskStatuses(dir);
  check(
    'the build is complete before re-entry',
    ['complete', 'complete', 'complete', 'complete', 'complete', 'complete'],
    Object.values(finished),
  );

  // ── Re-entry: new scope arrives on a finished build ────────────────
  addIntent(dir, 'payments');
  const replanned = cli(dir, ['plan']);
  check('re-entry plan exits 0', 0, replanned.status);

  check(
    'DEPLOY gained the new module as a prerequisite',
    ['ORDERS-API', 'PAYMENTS-API', 'USERS-API'],
    edgesInto(dir, 'DEPLOY'),
  );

  // A. The live graph must not still call DEPLOY complete.
  check('DEPLOY is reopened, not left complete', 'planned', taskStatuses(dir).DEPLOY);
  checkContains(
    'plan says out loud that the once-layer was reopened',
    `${replanned.stdout}${replanned.stderr}`,
    'reopened',
  );

  // B. …and a rebuild must not silently re-close it from the old commit.
  check('rebuild after re-entry exits 0', 0, rebuildFromScratch(dir).status);
  check('DEPLOY stays reopened across db rebuild', 'planned', taskStatuses(dir).DEPLOY);
  check(
    'the modules that did finish stay complete',
    { 'ORDERS-API': 'complete', 'USERS-API': 'complete', CLUSTER: 'complete' },
    {
      'ORDERS-API': taskStatuses(dir)['ORDERS-API'],
      'USERS-API': taskStatuses(dir)['USERS-API'],
      CLUSTER: taskStatuses(dir).CLUSTER,
    },
  );

  // The sharpest form of the bug: finish the new module and ask whether
  // the build is done. It is not — the deploy still has to run.
  commitTaskSubject(dir, 'PAYMENTS-SCHEMA');
  commitTaskSubject(dir, 'PAYMENTS-API');
  check('rebuild after the new module lands exits 0', 0, rebuildFromScratch(dir).status);

  check(
    'the new module is built but the build-wide deploy is still outstanding',
    { 'PAYMENTS-API': 'complete', DEPLOY: 'planned' },
    {
      'PAYMENTS-API': taskStatuses(dir)['PAYMENTS-API'],
      DEPLOY: taskStatuses(dir).DEPLOY,
    },
  );

  const status = cli(dir, ['status']);
  checkContains('hedgehog status still lists DEPLOY as ready', status.stdout, 'DEPLOY');
  const next = cli(dir, ['next']);
  checkContains('hedgehog next hands DEPLOY back out', next.stdout, 'TASK  DEPLOY');

  // …and it must still be able to close. Reopening is not a ratchet: run
  // the deploy again and the graph goes green, including across a rebuild
  // — the second `chore(infra): deploy` now sits above the payments
  // commits in history.
  commitTaskSubject(dir, 'DEPLOY');
  check('final rebuild exits 0', 0, rebuildFromScratch(dir).status);
  check(
    'the build closes once the deploy actually re-runs',
    ['complete', 'complete', 'complete', 'complete', 'complete', 'complete', 'complete', 'complete'],
    Object.values(taskStatuses(dir)),
  );
} finally {
  cleanup(dir);
}

report('08 — a completed once layer reopens when new scope lands under it');
