#!/usr/bin/env node
// Repro: a genuine boundary exits 0 and positions a fresh session.
//
// Intent `alpha` is built to completion (both layers claimed, built,
// verified, committed), nothing is left in flight, and the working tree
// is clean — the exact moment the discipline says to clear context. The
// operator has no way to learn that today: `hedgehog quiesce` exits 0
// here, but it also exits 0 halfway through `alpha`, so its 0 doesn't
// mean "boundary".
//
// Expected: `hedgehog boundary` exits 0, names all three conditions on
// stderr, and prints the next task and why on stdout.

import {
  makeProject,
  completeNextTask,
  runCliCapturingBoth,
  cleanup,
  check,
  checkExit,
  checkContains,
  report,
} from './lib/fixture.mjs';

const project = makeProject();
try {
  completeNextTask(project); // ALPHA-MODEL
  completeNextTask(project); // ALPHA-VIEW — closes intent alpha

  const result = runCliCapturingBoth(project, ['boundary']);
  console.log('--- exit', result.status);
  console.log('--- stdout\n' + result.stdout);
  console.log('--- stderr\n' + result.stderr);

  checkExit('exits 0 at a genuine boundary', 0, result);
  checkContains('stderr names the verdict', 'Boundary reached.', result.stderr);
  checkContains('stderr names condition 1', 'nothing in flight', result.stderr);
  checkContains('stderr names condition 2', 'working tree clean', result.stderr);
  checkContains('stderr names condition 3', 'completed intent "alpha"', result.stderr);
  checkContains('stdout positions the next task', 'BETA-MODEL', result.stdout);
  checkContains('stdout says why it is next', 'WHY', result.stdout);
  check('stderr commentary stays off stdout', {
    expected: false,
    actual: result.stdout.includes('Boundary reached.'),
  });

  // Script-friendly: exit code only, nothing on either stream.
  const quiet = runCliCapturingBoth(project, ['boundary', '--quiet'], {
    env: { NODE_NO_WARNINGS: '1' },
  });
  checkExit('--quiet exits 0 at a boundary', 0, quiet);
  check('--quiet prints nothing to stdout', { expected: '', actual: quiet.stdout });
  check('--quiet prints nothing to stderr', { expected: '', actual: quiet.stderr });

  // Usable as a handoff: a block a fresh session can be started with.
  const handoff = runCliCapturingBoth(project, ['boundary', '--handoff']);
  console.log('--- handoff stdout\n' + handoff.stdout);
  checkExit('--handoff exits 0 at a boundary', 0, handoff);
  checkContains('handoff names itself', 'HEDGEHOG HANDOFF', handoff.stdout);
  checkContains('handoff says where the build is', 'BUILD', handoff.stdout);
  checkContains('handoff says what is next', 'BETA-MODEL', handoff.stdout);
  checkContains('handoff says what is blocked', 'BLOCKED', handoff.stdout);
  checkContains('handoff reports the boundary verdict', 'BOUNDARY', handoff.stdout);
} finally {
  cleanup(project);
}

report('boundary-at-boundary');
