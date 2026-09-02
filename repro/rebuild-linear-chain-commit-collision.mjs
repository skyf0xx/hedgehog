// A linear-chain core (no module axis — the authored/adopted shape) has
// no `{module}` in any layer's `commit` template, so every intent that
// walks the chain compiles a per-layer task carrying the exact same
// commit_message as every other intent's task for that layer. Against
// the pre-fix compiler, `hedgehog db rebuild` marked a fresh intent's
// tasks complete purely because an EARLIER intent's real commit for the
// same layer already existed in history — with zero commits and zero
// files touched for the new intent's own work.
//
// Two intents on the same linear chain: "alpha" finishes for real (a
// commit lands for every layer), then "beta" is added fresh with no
// commits of its own. A rebuild must leave every one of beta's tasks
// exactly where `hedgehog plan` left them.

import {
  makeProject,
  addIntent,
  cli,
  commitTaskSubject,
  rebuildFromScratch,
  taskStatuses,
  cleanup,
  check,
  report,
  LINEAR_CORE,
} from './_lib.mjs';

const dir = makeProject(LINEAR_CORE, { git: true });
try {
  addIntent(dir, 'alpha');
  check('first plan exits 0', 0, cli(dir, ['plan']).status);

  for (const id of ['ALPHA-SCAFFOLD', 'ALPHA-LOGIC', 'ALPHA-SMOKE']) {
    commitTaskSubject(dir, id);
  }
  check('rebuild after alpha finishes exits 0', 0, rebuildFromScratch(dir).status);
  check(
    'alpha is complete before beta is added',
    { 'ALPHA-SCAFFOLD': 'complete', 'ALPHA-LOGIC': 'complete', 'ALPHA-SMOKE': 'complete' },
    {
      'ALPHA-SCAFFOLD': taskStatuses(dir)['ALPHA-SCAFFOLD'],
      'ALPHA-LOGIC': taskStatuses(dir)['ALPHA-LOGIC'],
      'ALPHA-SMOKE': taskStatuses(dir)['ALPHA-SMOKE'],
    },
  );

  // beta shares every layer's commit_message with alpha, verbatim, and
  // gets zero commits of its own.
  addIntent(dir, 'beta');
  check('second plan exits 0', 0, cli(dir, ['plan']).status);
  check(
    'beta compiles planned, not complete, before any rebuild',
    { 'BETA-SCAFFOLD': 'planned', 'BETA-LOGIC': 'planned', 'BETA-SMOKE': 'planned' },
    {
      'BETA-SCAFFOLD': taskStatuses(dir)['BETA-SCAFFOLD'],
      'BETA-LOGIC': taskStatuses(dir)['BETA-LOGIC'],
      'BETA-SMOKE': taskStatuses(dir)['BETA-SMOKE'],
    },
  );

  check('rebuild from scratch exits 0', 0, rebuildFromScratch(dir).status);

  const after = taskStatuses(dir);
  check(
    "beta's tasks stay uncompleted across a rebuild with zero commits of its own",
    { 'BETA-SCAFFOLD': 'planned', 'BETA-LOGIC': 'planned', 'BETA-SMOKE': 'planned' },
    {
      'BETA-SCAFFOLD': after['BETA-SCAFFOLD'],
      'BETA-LOGIC': after['BETA-LOGIC'],
      'BETA-SMOKE': after['BETA-SMOKE'],
    },
  );
  check(
    "alpha's real completion survives the same rebuild",
    { 'ALPHA-SCAFFOLD': 'complete', 'ALPHA-LOGIC': 'complete', 'ALPHA-SMOKE': 'complete' },
    {
      'ALPHA-SCAFFOLD': after['ALPHA-SCAFFOLD'],
      'ALPHA-LOGIC': after['ALPHA-LOGIC'],
      'ALPHA-SMOKE': after['ALPHA-SMOKE'],
    },
  );

  // beta really does finish once it commits for real, including across
  // a further rebuild — the fix is not a ratchet against real progress.
  for (const id of ['BETA-SCAFFOLD', 'BETA-LOGIC', 'BETA-SMOKE']) {
    commitTaskSubject(dir, id);
  }
  check('rebuild after beta finishes for real exits 0', 0, rebuildFromScratch(dir).status);
  check(
    'beta completes once its own commits exist',
    { 'BETA-SCAFFOLD': 'complete', 'BETA-LOGIC': 'complete', 'BETA-SMOKE': 'complete' },
    {
      'BETA-SCAFFOLD': taskStatuses(dir)['BETA-SCAFFOLD'],
      'BETA-LOGIC': taskStatuses(dir)['BETA-LOGIC'],
      'BETA-SMOKE': taskStatuses(dir)['BETA-SMOKE'],
    },
  );
} finally {
  cleanup(dir);
}

report('rebuild does not credit a fresh intent from an earlier intent\'s identical commit_message on a linear-chain core');
