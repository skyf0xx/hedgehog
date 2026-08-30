// `hedgehog abandon <id>` must refuse an intent that is already
// `complete` (merged) rather than silently un-shipping it back to
// `planned`. applyAbandonment resets every non-planned task to `planned`
// unconditionally otherwise — a user abandoning a merged intent by
// mistake (wrong id, stale memory) would revert real, shipped work on
// trunk, and the committed abandonment record would keep re-applying that
// reset on every future `hedgehog db rebuild` via replayAbandonments.
// Mirrors reconcile.mjs#confirmReconciliation's own refusal of an
// already-complete task.

import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  makeProject,
  cli,
  openGraph,
  commitTaskSubject,
  cleanup,
  check,
  report,
} from './_lib.mjs';

const CORE = `
id: abandon-complete-fixture
layers:
  - id: view
    scope: ["src/{module}/**"]
    verify: "true"
    commit: "feat({module}): view"
`;

const dir = makeProject(CORE, { git: true });
try {
  writeFileSync(
    join(dir, '.gitignore'),
    '.hedgehog/hedgehog.db\n.hedgehog/hedgehog.db-*\n.hedgehog/commit.lock\n',
  );
  execFileSync('git', ['add', '.gitignore'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: gitignore build graph'], { cwd: dir });

  check('add alpha exits 0', 0, cli(dir, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']).status);
  check('first plan exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  commitTaskSubject(dir, 'ALPHA-VIEW');
  check('rebuild after alpha commit exits 0', 0, cli(dir, ['db', 'rebuild']).status);

  const beforeDb = openGraph(dir);
  let alphaStatusBefore, alphaTaskStatusBefore;
  try {
    alphaStatusBefore = beforeDb.prepare("SELECT status FROM intents WHERE id = 'alpha'").get().status;
    alphaTaskStatusBefore = beforeDb.prepare("SELECT status FROM tasks WHERE id = 'ALPHA-VIEW'").get().status;
  } finally {
    beforeDb.close();
  }
  check('alpha intent is complete before the mistaken abandon', 'complete', alphaStatusBefore);
  check('alpha task is complete before the mistaken abandon', 'complete', alphaTaskStatusBefore);

  // The mistake: abandoning an already-merged, complete intent.
  const abandon = cli(dir, ['abandon', 'alpha', '--reason', 'wrong id, meant to abandon something else']);
  check('abandoning an already-complete intent refuses (non-zero exit)', 1, abandon.status);

  const afterDb = openGraph(dir);
  let alphaStatusAfter, alphaTaskStatusAfter;
  try {
    alphaStatusAfter = afterDb.prepare("SELECT status FROM intents WHERE id = 'alpha'").get().status;
    alphaTaskStatusAfter = afterDb.prepare("SELECT status FROM tasks WHERE id = 'ALPHA-VIEW'").get().status;
  } finally {
    afterDb.close();
  }
  check('alpha intent is still complete after the refused abandon', 'complete', alphaStatusAfter);
  check('alpha task is still complete after the refused abandon', 'complete', alphaTaskStatusAfter);

  // No abandonment record should have been written for a refused
  // operation — file-before-graph means a refusal must leave no trace.
  const status = cli(dir, ['status']);
  check('status exits 0', 0, status.status);

  // A rebuild afterwards must also still show alpha complete — proving no
  // stray .hedgehog/abandoned/alpha.json survived to be replayed.
  const rebuildAfter = cli(dir, ['db', 'rebuild']);
  check('rebuild after the refused abandon exits 0', 0, rebuildAfter.status);
  const rebuiltDb = openGraph(dir);
  let alphaStatusRebuilt;
  try {
    alphaStatusRebuilt = rebuiltDb.prepare("SELECT status FROM intents WHERE id = 'alpha'").get().status;
  } finally {
    rebuiltDb.close();
  }
  check('alpha intent is still complete after a rebuild', 'complete', alphaStatusRebuilt);
} finally {
  cleanup(dir);
}

report('hedgehog abandon refuses an already-complete (merged) intent instead of un-shipping it');
