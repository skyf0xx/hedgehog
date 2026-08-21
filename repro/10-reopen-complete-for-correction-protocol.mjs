// A Correction Protocol fix discovers, downstream, that an already
// `complete` layer was wrong. Before `hedgehog reopen`, nothing in the
// CLI moved a `complete` task backward: `retry` only accepts `blocked`,
// `release` only accepts `building`, `verify` only accepts a task leased
// to the caller. The only way to land the fix was a hand-authored commit
// outside `hedgehog verify` entirely, bypassing the build graph.
//
// Two things this command must get right:
//   A. Reopening an upstream layer must reopen every already-complete
//      layer built on top of it too — a dependent's completion is only
//      honest relative to what it was built against, and a stale
//      dependent left `complete` would report the build done while it
//      still reflects the un-fixed upstream output.
//   B. It must require `--confirm` — this undoes verified, committed,
//      possibly-built-upon work, which is a different order of
//      consequence than retrying a task the loop itself just blocked.

import {
  makeProject,
  addIntent,
  cli,
  commitTaskSubject,
  rebuildFromScratch,
  taskStatuses,
  cleanup,
  check,
  checkContains,
  report,
} from './_lib.mjs';

// A straight three-layer chain on one module: schema -> api -> smoke.
const CORE = `
id: reopen-fixture
layers:
  - id: schema
    scope: ["libs/{module}/schema/**"]
    verify: "true"
    commit: "feat({module}): schema"
  - id: api
    depends_on: schema
    scope: ["apps/api/{module}/**"]
    verify: "true"
    commit: "feat({module}): api"
  - id: smoke
    depends_on: api
    scope: ["tests/{module}/**"]
    verify: "true"
    commit: "test({module}): smoke"
`;

const dir = makeProject(CORE, { git: true });
try {
  addIntent(dir, 'sassy');
  check('plan exits 0', 0, cli(dir, ['plan']).status);

  for (const id of ['SASSY-SCHEMA', 'SASSY-API', 'SASSY-SMOKE']) {
    commitTaskSubject(dir, id);
  }
  check('rebuild after the chain lands exits 0', 0, rebuildFromScratch(dir).status);
  check(
    'the whole chain is complete before the correction',
    { 'SASSY-API': 'complete', 'SASSY-SCHEMA': 'complete', 'SASSY-SMOKE': 'complete' },
    taskStatuses(dir),
  );

  // Reopen refuses without --confirm, and changes nothing.
  const unconfirmed = cli(dir, ['reopen', 'SASSY-SCHEMA']);
  check('reopen without --confirm exits non-zero', true, unconfirmed.status !== 0);
  checkContains(
    'reopen without --confirm names the flag it needs',
    `${unconfirmed.stdout}${unconfirmed.stderr}`,
    '--confirm',
  );
  check(
    'nothing moved without --confirm',
    { 'SASSY-API': 'complete', 'SASSY-SCHEMA': 'complete', 'SASSY-SMOKE': 'complete' },
    taskStatuses(dir),
  );

  // retry refuses a complete task outright — it only accepts blocked.
  const retried = cli(dir, ['retry', 'SASSY-SCHEMA']);
  check('retry on a complete task exits non-zero', true, retried.status !== 0);

  // Reopening the schema layer must cascade to api and smoke, both
  // already complete and built on top of it.
  const reopened = cli(dir, ['reopen', 'SASSY-SCHEMA', '--confirm']);
  check('reopen --confirm exits 0', 0, reopened.status);
  checkContains('reopen reports the transition', reopened.stdout, 'Reopened');
  check(
    'the fixed layer and every complete dependent go back to planned',
    { 'SASSY-API': 'planned', 'SASSY-SCHEMA': 'planned', 'SASSY-SMOKE': 'planned' },
    taskStatuses(dir),
  );

  // The loop closes normally from here: claim, verify, and the chain is
  // complete again — reopening is not a ratchet. Claiming picks the one
  // ready task (SASSY-SCHEMA, nothing else has a satisfied dependency
  // set yet); verifying it unlocks SASSY-API to `ready` in turn.
  check('claim after reopen exits 0', 0, cli(dir, ['claim', '--owner', 'ag1']).status);
  check(
    'verify after reopen exits 0',
    0,
    cli(dir, ['verify', 'SASSY-SCHEMA', '--owner', 'ag1']).status,
  );
  check(
    'the fixed layer is complete again and its dependent is unlocked',
    { 'SASSY-SCHEMA': 'complete', 'SASSY-API': 'ready' },
    { 'SASSY-SCHEMA': taskStatuses(dir)['SASSY-SCHEMA'], 'SASSY-API': taskStatuses(dir)['SASSY-API'] },
  );

  // A no-op reopen: reopening a task that isn't complete refuses cleanly.
  const reopenAgain = cli(dir, ['reopen', 'SASSY-API', '--confirm']);
  check('reopening a task that is not complete refuses', true, reopenAgain.status !== 0);
  checkContains(
    "refusal names the task's actual status",
    `${reopenAgain.stdout}${reopenAgain.stderr}`,
    'ready',
  );
} finally {
  cleanup(dir);
}

report('10 — reopen returns a complete task and its complete dependents to planned');
