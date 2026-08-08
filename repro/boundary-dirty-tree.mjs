#!/usr/bin/env node
// Repro: a dirty working tree is not a boundary, and the command says so.
//
// Intent `alpha` closes cleanly and nothing is in flight — `hedgehog
// quiesce` exits 0 here — but an uncommitted file is sitting in the
// working tree. Clearing context now discards the only knowledge of why
// that file exists, since it is in no commit and in no task's artifacts.
//
// Expected: non-zero exit, and stderr marks the clean-tree condition
// failed and names the offending path. The engine's own gitignored
// files must not count as dirt.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeProject,
  completeNextTask,
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

  writeFileSync(join(project, 'stray-note.txt'), 'half-finished work\n');

  const result = runCliCapturingBoth(project, ['boundary']);
  console.log('--- exit', result.status);
  console.log('--- stdout\n' + result.stdout);
  console.log('--- stderr\n' + result.stderr);

  checkNonZeroExit('exits non-zero with a dirty working tree', result);
  checkContains('stderr names the verdict', 'Not a boundary.', result.stderr);
  checkContains('stderr marks the clean-tree condition failed', '✗ working tree clean', result.stderr);
  checkContains('stderr names the uncommitted path', 'stray-note.txt', result.stderr);
  checkContains('stderr still passes the in-flight condition', '✓ nothing in flight', result.stderr);
} finally {
  cleanup(project);
}

report('boundary-dirty-tree');
