#!/usr/bin/env node --experimental-sqlite
// KNOWN LIMITATION, pinned deliberately — passes before and after.
//
// One shape the claim-time snapshot does not and cannot fix: a path
// outside every in-flight task's declared scope, changed at some point
// *during* the lease by something other than the task being verified.
//
// There is one working tree and no record of who wrote what, so nothing
// distinguishes that from the task's own stray write. Exonerating it
// would mean any out-of-scope write becomes forgivable as long as some
// other task happens to be in flight — that is weakening the gate, which
// is worse than the misattribution it would cure. The gate keeps
// failing, and the fix is to declare the path in a scope (where the
// neighbour-exclusion rule then covers it), not to widen the amnesty.
//
// This file exists so that a future change which quietly "fixes" this
// case has to argue with a failing assertion first.

import { makeRepo, cleanup, seedTask, claimOrThrow, runVerify, append, taskRow, check, finish } from './lib.mjs';

const NAME = '05-known-limitation-unattributable-write';
console.log(`${NAME}\n`);

const dir = makeRepo();
try {
  seedTask(dir, { id: 't1', scope: ['pkg-a/**'] });
  seedTask(dir, { id: 't2', scope: ['pkg-b/**'] });
  claimOrThrow(dir, { count: 2 });

  // t1's agent stays inside its scope.
  append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');
  // t2's agent writes a shared seam that is in nobody's declared scope —
  // a violation on t2's part, invisibly indistinguishable from one on
  // t1's part.
  append(dir, 'shared.json', '{"seams":1}\n');

  const res = runVerify(dir, 't1');
  const row = taskRow(dir, 't1');
  check('undeclared shared-seam write during the lease: still blocks', res.code !== 0, true);
  check('undeclared shared-seam write during the lease: names the path', res.out.includes('shared.json'), true);
  check(
    'undeclared shared-seam write during the lease: blocked reason',
    [row.status, row.blocked_reason],
    ['blocked', 'scope_violation'],
  );
} finally {
  cleanup(dir);
}

finish(NAME);
