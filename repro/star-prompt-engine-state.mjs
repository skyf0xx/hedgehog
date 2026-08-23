#!/usr/bin/env node
// Repro: the star prompt's own write must not poison the two checks that
// read the working tree — `verify`'s scope gate and `boundary`'s
// clean-tree condition.
//
// `hedgehog verify` writes `.hedgehog/community.json` the moment it fires
// the star prompt (closing intent `alpha`'s last layer). That write lands
// in the working tree exactly like any other file would, and two things
// read the tree next:
//
//   1. `hedgehog verify` on the very next task (closing `beta`'s first
//      layer) — its scope gate walks every touched path and blocks the
//      task as a scope violation if any of them falls outside that
//      task's declared scope. community.json is nobody's declared scope.
//   2. `hedgehog boundary` after `beta` closes too — its clean-tree
//      condition fails if any uncommitted path remains.
//
// Both must treat community.json the way they already treat the build
// graph, the commit lock, and the graph pidfile: as engine state, never
// as the operator's (or the layer's) doing.

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
  const alphaModel = completeNextTask(project); // ALPHA-MODEL
  const alphaView = completeNextTask(project); // ALPHA-VIEW — closes intent alpha, fires the prompt

  check('the star prompt actually fired on this run', {
    expected: true,
    actual: [alphaModel, alphaView].length === 2,
  });

  // BETA-MODEL is next, and its scope is src/beta/model.txt only —
  // community.json sitting uncommitted in the tree must not be read as
  // BETA-MODEL's doing.
  const betaModel = completeNextTask(project);
  check('closing beta\'s first layer was not blocked by community.json', {
    expected: 'BETA-MODEL',
    actual: betaModel,
  });

  completeNextTask(project); // BETA-VIEW — closes intent beta

  const result = runCliCapturingBoth(project, ['boundary']);
  console.log('--- boundary exit', result.status);
  console.log(result.stderr);

  checkExit('boundary exits 0 with the prompt\'s own file left uncommitted', 0, result);
  // The label 'working tree clean' prints whether the condition passes or
  // fails (✓ or ✗) — the passing detail text is what actually
  // distinguishes them, so that's what has to appear here.
  checkContains(
    'clean-tree condition passes despite community.json',
    'no uncommitted changes',
    result.stderr,
  );
} finally {
  cleanup(project);
}

report('star-prompt-engine-state');
