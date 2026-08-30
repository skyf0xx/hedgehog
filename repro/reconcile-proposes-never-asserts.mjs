// `hedgehog reconcile` proposes; it never closes a task on its own.
//
// The evidence it gathers is a diff overlap: files a commit touched, and
// the scope globs a task compiled. That says work landed where a task
// would have put it. It says nothing about whether the task's objective
// was met — two tasks can share a scope prefix, and one commit inside it
// satisfies neither on the strength of the overlap alone.
//
// So the command has exactly one shape that closes anything: `confirm`,
// naming one task id. This asserts the properties that keeps true:
//   1. running `reconcile` with matching evidence changes no task status
//   2. there is no bulk confirm — no flag closes more than one task
//   3. confirming one candidate leaves every other candidate open
//   4. `status`, `next`, and `claim` never reconcile on their own

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeProject,
  addIntent,
  cli,
  taskStatuses,
  cleanup,
  check,
  checkContains,
  report,
} from './_lib.mjs';

// Two modules on one layer, so one commit can put files in both tasks'
// scopes at once — the shape a bulk confirm would close wholesale.
const CORE = `
id: reconcile-fixture
layers:
  - id: schema
    scope: ["libs/{module}/schema/**"]
    verify: "true"
    commit: "feat({module}): schema"
`;

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}

const dir = makeProject(CORE, { git: true });
try {
  addIntent(dir, 'alpha');
  addIntent(dir, 'beta');
  check('plan exits 0', 0, cli(dir, ['plan']).status);

  // One hand-written commit touching both modules' scopes.
  for (const module of ['alpha', 'beta']) {
    mkdirSync(join(dir, `libs/${module}/schema`), { recursive: true });
    writeFileSync(join(dir, `libs/${module}/schema/model.txt`), 'hand-written\n');
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'add both schemas by hand']);

  const openBefore = taskStatuses(dir);

  // 1. Reading the evidence changes nothing.
  const proposal = cli(dir, ['reconcile']);
  check('reconcile exits 0', 0, proposal.status);
  checkContains('it proposes ALPHA-SCHEMA', proposal.stdout, 'ALPHA-SCHEMA');
  checkContains('it proposes BETA-SCHEMA', proposal.stdout, 'BETA-SCHEMA');
  check('no task status changed', openBefore, taskStatuses(dir));

  // 2. No bulk form exists. Each of these is rejected rather than
  //    quietly interpreted as "every candidate".
  for (const args of [
    ['reconcile', 'confirm', '--all', '--reason', 'all of them'],
    ['reconcile', 'confirm-all', '--reason', 'all of them'],
    ['reconcile', 'confirm', '--reason', 'no task named'],
  ]) {
    check(`\`${args.join(' ')}\` is refused`, 1, cli(dir, args).status);
  }
  check('no task status changed by a refused bulk form', openBefore, taskStatuses(dir));

  // 3. Confirming one candidate leaves the other open.
  check(
    'confirming ALPHA-SCHEMA exits 0',
    0,
    cli(dir, ['reconcile', 'confirm', 'ALPHA-SCHEMA', '--reason', 'read the diff, it is done'])
      .status,
  );
  const after = taskStatuses(dir);
  check('ALPHA-SCHEMA is complete', 'complete', after['ALPHA-SCHEMA']);
  check(
    'BETA-SCHEMA is untouched by that confirmation',
    openBefore['BETA-SCHEMA'],
    after['BETA-SCHEMA'],
  );

  // A reason is mandatory — the permanent record of why a task closed
  // with nothing checked cannot be blank.
  check(
    'confirming without a reason is refused',
    1,
    cli(dir, ['reconcile', 'confirm', 'BETA-SCHEMA']).status,
  );
  check('BETA-SCHEMA is still open', openBefore['BETA-SCHEMA'], taskStatuses(dir)['BETA-SCHEMA']);

  // 4. The read-only commands never reconcile on their own.
  const settled = taskStatuses(dir);
  cli(dir, ['status']);
  cli(dir, ['next']);
  cli(dir, ['claim', '--owner', 'repro']);
  cli(dir, ['ready']);
  const stillOpen = taskStatuses(dir);
  check(
    'BETA-SCHEMA was not reconciled by status/next/claim/ready',
    settled['BETA-SCHEMA'],
    // claim legitimately leases it; what must not happen is `complete`.
    stillOpen['BETA-SCHEMA'] === 'building' ? settled['BETA-SCHEMA'] : stillOpen['BETA-SCHEMA'],
  );
  check(
    'no command other than reconcile closed BETA-SCHEMA',
    false,
    stillOpen['BETA-SCHEMA'] === 'complete',
  );
} finally {
  cleanup(dir);
}

report('hedgehog reconcile proposes evidence and closes only what the user names');
