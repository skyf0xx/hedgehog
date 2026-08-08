#!/usr/bin/env node
// Repro: mid-intent is not a boundary, and the command says so.
//
// This is the condition nothing in the CLI can answer today. One layer
// of intent `alpha` is committed; the next layer of the same intent is
// ready. Nothing is in flight and the tree is clean, so `hedgehog
// quiesce` exits 0 — but the intent is half built, which is exactly the
// state the discipline does not want a conversation thrown away in.
// `hedgehog verify` printed "intent complete" when the intent closed;
// nothing records that it did *not* print it here.
//
// Expected: non-zero exit, and stderr marks the intent condition failed,
// naming the last closed task and what remains.

import {
  makeProject,
  completeNextTask,
  runCli,
  runCliCapturingBoth,
  cleanup,
  checkExit,
  checkNonZeroExit,
  checkContains,
  report,
} from './lib/fixture.mjs';

const project = makeProject();
try {
  const closed = completeNextTask(project); // ALPHA-MODEL only
  console.log('--- closed', closed);

  // The state `quiesce` calls settled — necessary, but not the boundary.
  const quiesce = runCliCapturingBoth(project, ['quiesce']);
  checkExit('quiesce exits 0 mid-intent (the gap being closed)', 0, quiesce);

  const result = runCliCapturingBoth(project, ['boundary']);
  console.log('--- exit', result.status);
  console.log('--- stdout\n' + result.stdout);
  console.log('--- stderr\n' + result.stderr);

  checkNonZeroExit('exits non-zero mid-intent', result);
  checkContains('stderr names the verdict', 'Not a boundary.', result.stderr);
  checkContains(
    'stderr marks the intent condition failed',
    '✗ last closed task completed an intent',
    result.stderr,
  );
  checkContains('stderr names the last closed task', 'ALPHA-MODEL', result.stderr);
  checkContains('stderr names what remains of the intent', 'ALPHA-VIEW', result.stderr);
  checkContains('stderr still passes the in-flight condition', '✓ nothing in flight', result.stderr);
  checkContains('stderr still passes the clean-tree condition', '✓ working tree clean', result.stderr);

  // The handoff block is still usable when it isn't a boundary — a fresh
  // session still has to be positioned, it just isn't a free moment to
  // start one.
  const handoff = runCliCapturingBoth(project, ['boundary', '--handoff']);
  checkNonZeroExit('--handoff keeps the non-zero verdict', handoff);
  checkContains('handoff still positions the next task', 'ALPHA-VIEW', handoff.stdout);

  // Nothing built at all is also not a boundary — there is no closed
  // intent to sit behind.
  const fresh = makeProject();
  try {
    const freshResult = runCliCapturingBoth(fresh, ['boundary']);
    checkNonZeroExit('exits non-zero before anything is built', freshResult);
    checkContains('stderr says no task has completed yet', 'no task has completed yet', freshResult.stderr);
  } finally {
    cleanup(fresh);
  }

  runCli(project, ['status']);
} finally {
  cleanup(project);
}

report('boundary-intent-incomplete');
