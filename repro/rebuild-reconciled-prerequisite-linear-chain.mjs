// A reconciled task's completion has to be visible to markCompletedTasks's
// own ambiguous-task fixpoint walk, not just to replayReconciliations
// (which runs afterward) — otherwise every later intent sharing that
// layer's commit_message (the linear-chain ambiguity condition) can never
// resolve its own ordering/consumption check against it, and a rebuild
// permanently under-reports real, committed work (issue #430).
//
// Linear-chain core (LINEAR_CORE: no `{module}` token, so every intent's
// per-layer task shares the same commit_message with every other intent's
// task for that layer). "alpha"'s SCAFFOLD closes by reconciliation
// (Bootstrap's own commit already covered that scope, so it has no commit
// of its own matching commitSubjects). "beta" then does every layer for
// real, including its own BETA-SCAFFOLD commit. Pre-fix, BETA-SCAFFOLD's
// ambiguous-group ordering check has nothing to check position against —
// alpha's reconciled completion isn't in markCompletedTasks's `complete`
// set yet when the fixpoint walk runs — so it, and everything chained
// after it, stays `planned` forever despite three real commits existing.

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

  // alpha's SCAFFOLD closes by reconciliation, not a matching commit —
  // Bootstrap's own commit already covered that scope, the shape #430
  // reports.
  const confirmed = cli(dir, [
    'reconcile',
    'confirm',
    'ALPHA-SCAFFOLD',
    '--reason',
    'covered by an earlier commit outside the loop',
  ]);
  check('reconcile confirm exits 0', 0, confirmed.status);
  check(
    'ALPHA-SCAFFOLD is complete after reconciliation',
    'complete',
    taskStatuses(dir)['ALPHA-SCAFFOLD'],
  );

  // alpha's remaining layers finish for real.
  for (const id of ['ALPHA-LOGIC', 'ALPHA-SMOKE']) commitTaskSubject(dir, id);
  check('rebuild after alpha finishes exits 0', 0, rebuildFromScratch(dir).status);
  check(
    'alpha is fully complete, including its reconciled first layer',
    { 'ALPHA-SCAFFOLD': 'complete', 'ALPHA-LOGIC': 'complete', 'ALPHA-SMOKE': 'complete' },
    {
      'ALPHA-SCAFFOLD': taskStatuses(dir)['ALPHA-SCAFFOLD'],
      'ALPHA-LOGIC': taskStatuses(dir)['ALPHA-LOGIC'],
      'ALPHA-SMOKE': taskStatuses(dir)['ALPHA-SMOKE'],
    },
  );

  // beta shares every layer's commit_message with alpha, verbatim (the
  // linear-chain ambiguity condition), and this time finishes for real —
  // three genuine commits, zero shortcuts.
  addIntent(dir, 'beta');
  check('second plan exits 0', 0, cli(dir, ['plan']).status);
  for (const id of ['BETA-SCAFFOLD', 'BETA-LOGIC', 'BETA-SMOKE']) commitTaskSubject(dir, id);

  check('rebuild after beta finishes exits 0', 0, rebuildFromScratch(dir).status);
  const after = taskStatuses(dir);
  check(
    "beta's real, fully-committed chain resolves complete once alpha's reconciled prerequisite is visible to the same rebuild",
    { 'BETA-SCAFFOLD': 'complete', 'BETA-LOGIC': 'complete', 'BETA-SMOKE': 'complete' },
    {
      'BETA-SCAFFOLD': after['BETA-SCAFFOLD'],
      'BETA-LOGIC': after['BETA-LOGIC'],
      'BETA-SMOKE': after['BETA-SMOKE'],
    },
  );

  // Repeating the rebuild must not regress it — the permanence #430
  // reports ("rerunning `db rebuild` reproduces the exact same result
  // every time").
  check('a second rebuild exits 0', 0, rebuildFromScratch(dir).status);
  check(
    "beta's chain stays complete across a repeat rebuild",
    'complete',
    taskStatuses(dir)['BETA-SMOKE'],
  );
} finally {
  cleanup(dir);
}

report(
  "db rebuild sees a reconciled prerequisite as complete inside the same rebuild's ambiguous-task resolution",
);
