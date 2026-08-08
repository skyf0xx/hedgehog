// The reopen in 08 has one state it must not perform silently: the
// once-task is leased and running right now. An agent is part-way through
// `terraform apply` against the prerequisite set it was handed; slipping a
// new dependency under it would either be ignored (it verifies and
// completes against the old set anyway) or break the lease invariant on
// the way back to `planned`.
//
// `hedgehog plan` refuses the whole run instead, names the task and the
// intent, and says what to do. Nothing is compiled — the transaction
// rolls back — so re-running after the task lands does the right thing.

import {
  makeProject,
  addIntent,
  cli,
  taskIds,
  taskStatuses,
  cleanup,
  check,
  checkContains,
  report,
} from './_lib.mjs';

// A two-layer core: per-module `api`, then a build-wide `deploy` under it.
const CORE = `
id: inflight-fixture
layers:
  - id: api
    scope: ["apps/api/{module}/**"]
    verify: "true"
    commit: "feat({module}): api"
  - id: deploy
    depends_on: api
    scope: ["infra/deploy/**"]
    verify: "true"
    exclusive: true
    once: true
    commit: "chore(infra): deploy"
`;

const dir = makeProject(CORE);
try {
  addIntent(dir, 'users');
  check('first plan exits 0', 0, cli(dir, ['plan']).status);

  // Get USERS-API out of the way so DEPLOY becomes claimable, then lease
  // it — that is the in-flight state.
  cli(dir, ['claim', '--owner', 'w1', '--count', '1']);
  const db = (await import('node:sqlite')).DatabaseSync;
  const handle = new db(`${dir}/.hedgehog/hedgehog.db`);
  handle
    .prepare(
      `UPDATE tasks SET status = 'complete', lease_owner = NULL,
         lease_expires_at = NULL, leased_at = NULL WHERE id = 'USERS-API'`,
    )
    .run();
  handle.close();
  cli(dir, ['claim', '--owner', 'w2', '--count', '1']);
  check('DEPLOY is in flight', 'building', taskStatuses(dir).DEPLOY);

  const before = taskIds(dir);
  const replanned = (() => {
    addIntent(dir, 'orders');
    return cli(dir, ['plan']);
  })();

  check('plan refuses while the once-task is in flight', true, replanned.status !== 0);
  const output = `${replanned.stdout}${replanned.stderr}`;
  checkContains('names the once-task', output, 'DEPLOY');
  checkContains('names the state it is in', output, 'building');
  checkContains('names the intent that triggered it', output, 'orders');
  checkContains('says what to do about it', output, 'hedgehog plan');

  check('nothing was compiled — the transaction rolled back', before, taskIds(dir));
  check('the in-flight task keeps its lease', 'building', taskStatuses(dir).DEPLOY);
} finally {
  cleanup(dir);
}

report('09 — replanning under an in-flight once-task is refused, not guessed');
