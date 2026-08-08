// The scheduler half of the report, independent of cardinality.
//
// conflicts() returns 'exclusive' when *either* side is exclusive, so
// claimTasks can only ever accept an exclusive candidate while its
// `against` set is still empty — i.e. only when it is the first candidate
// the ORDER BY hands it. Ordered by id alone, an exclusive task loses its
// slot to any non-exclusive candidate that sorts ahead of it, and since
// every completing task unlocks its successor there is nearly always one.
//
// Here `provision` is an exclusive *first* layer, so ZULU-PROVISION being
// skipped means the whole `zulu` module is held back behind the entirety
// of `alpha`'s chain. This reproduces that and asserts the exclusive task
// is claimed once the build is idle.

import { makeProject, addIntent, cli, openGraph, cleanup, check, report } from './_lib.mjs';

const CORE = `
id: exclusive-head
layers:
  - id: provision
    scope: ["infra/{module}/**"]
    verify: "true"
    exclusive: true
    commit: "chore({module}): provision"
  - id: schema
    depends_on: provision
    scope: ["libs/{module}/schema/**"]
    verify: "true"
    commit: "feat({module}): schema"
  - id: api
    depends_on: schema
    scope: ["apps/api/{module}/**"]
    verify: "true"
    commit: "feat({module}): api"
`;

function leasedTo(dir, owner) {
  const db = openGraph(dir);
  try {
    return db
      .prepare('SELECT id FROM tasks WHERE lease_owner = ? ORDER BY id')
      .all(owner)
      .map((r) => r.id);
  } finally {
    db.close();
  }
}

// Stands in for a passing `hedgehog verify`: this reproduction is about
// which task the scheduler hands out next, not about the commit gate.
function markComplete(dir, taskId) {
  const db = openGraph(dir);
  try {
    db.prepare(
      `UPDATE tasks SET status = 'complete', lease_owner = NULL,
         lease_expires_at = NULL, leased_at = NULL WHERE id = ?`,
    ).run(taskId);
    db.prepare(
      `UPDATE tasks SET status = 'ready' WHERE status = 'planned' AND NOT EXISTS (
         SELECT 1 FROM dependencies d JOIN tasks dep ON dep.id = d.depends_on_task_id
         WHERE d.task_id = tasks.id AND dep.status <> 'complete')`,
    ).run();
  } finally {
    db.close();
  }
}

const dir = makeProject(CORE);
try {
  addIntent(dir, 'alpha');
  addIntent(dir, 'zulu');
  check('plan exits 0', 0, cli(dir, ['plan']).status);

  // Both head tasks are exclusive; the lower id wins the first slot.
  cli(dir, ['claim', '--owner', 'w1', '--count', '4']);
  check('first claim takes only ALPHA-PROVISION', ['ALPHA-PROVISION'], leasedTo(dir, 'w1'));
  markComplete(dir, 'ALPHA-PROVISION');

  // Now ALPHA-SCHEMA (non-exclusive) and ZULU-PROVISION (exclusive) are
  // both ready. Nothing is in flight, so this is the cheapest possible
  // moment to run the exclusive one.
  cli(dir, ['claim', '--owner', 'w2', '--count', '4']);
  check(
    'the idle build takes the exclusive ZULU-PROVISION rather than deferring it',
    ['ZULU-PROVISION'],
    leasedTo(dir, 'w2'),
  );
  markComplete(dir, 'ZULU-PROVISION');

  // With no exclusive work left, the fan-out is unchanged: both modules'
  // schema tasks are scope-disjoint and claim together.
  cli(dir, ['claim', '--owner', 'w3', '--count', '4']);
  check(
    'non-exclusive fan-out still claims both modules at once',
    ['ALPHA-SCHEMA', 'ZULU-SCHEMA'],
    leasedTo(dir, 'w3'),
  );
} finally {
  cleanup(dir);
}

report('07 — an exclusive task is not deferred behind lower-sorting work');
