#!/usr/bin/env node
// Repro: work in flight is not a boundary, and the command says so.
//
// Intent `alpha` closes cleanly, then BETA-MODEL is claimed — a lease is
// outstanding. Clearing context now orphans that lease until it expires,
// which is the one case `hedgehog quiesce` already catches. `boundary`
// must catch it too, and must name *this* condition rather than a
// generic failure.
//
// Expected: non-zero exit, and stderr marks the in-flight condition
// failed with the task and its owner.

import {
  makeProject,
  completeNextTask,
  runCli,
  runCliCapturingBoth,
  cleanup,
  checkNonZeroExit,
  checkContains,
  report,
} from './lib/fixture.mjs';

const project = makeProject();
try {
  completeNextTask(project); // ALPHA-MODEL
  completeNextTask(project); // ALPHA-VIEW — closes intent alpha

  const claimed = runCli(project, ['claim', '--owner', 'agent-7']);
  console.log('--- claim\n' + claimed.stdout);

  const result = runCliCapturingBoth(project, ['boundary']);
  console.log('--- exit', result.status);
  console.log('--- stdout\n' + result.stdout);
  console.log('--- stderr\n' + result.stderr);

  checkNonZeroExit('exits non-zero with a lease outstanding', result);
  checkContains('stderr names the verdict', 'Not a boundary.', result.stderr);
  checkContains('stderr marks the in-flight condition failed', '✗ nothing in flight', result.stderr);
  checkContains('stderr names the in-flight task', 'BETA-MODEL', result.stderr);
  checkContains('stderr names the lease owner', 'agent-7', result.stderr);
  checkContains('stderr still passes the clean-tree condition', '✓ working tree clean', result.stderr);
} finally {
  cleanup(project);
}

report('boundary-work-in-flight');
