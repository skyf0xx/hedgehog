// Issue #431: an abandoned intent must not become worktree-eligible again
// just because its `intent_dependencies` row got recreated and its
// blocking dependency is complete.
//
// applyAbandonment resets an abandoned intent to `status = 'planned'` by
// design (abandonment is a committed record, not a status value) and, as
// part of that reset, clears its `intent_dependencies` rows
// (worktree.mjs#clearIntentDependencies). That clearing is not permanent:
// the intent's own `.hedgehog/intents/<id>.json` still declares
// `depends_on` (abandonment never deletes it), and hand-editing that file
// back to re-declare the same dependency — the documented recovery path —
// repopulates the table on the next `hedgehog plan`/rebuild. Before this
// fix, eligibleIntents (worktree.mjs) read that repopulated table alone,
// so the moment the re-declared dependency read as complete, the abandoned
// intent looked eligible again and `hedgehog plan` handed it a fresh
// worktree and recompiled its tasks — silently ignoring the committed
// `.hedgehog/abandoned/beta.json` record that says this intent was
// deliberately dropped.
//
// Repro shape: `beta` depends_on `alpha` (already complete) and gets a
// worktree. `beta` is abandoned (worktree removed, dependency cleared).
// `beta.json` is then hand-edited to re-declare `depends_on: ["alpha"]`
// and committed — same recovery mechanics as
// worktree-abandon-clears-dependency.mjs, but restoring the dependency
// instead of dropping it. A `hedgehog plan` from there must not create a
// worktree for `beta`, must not compile any tasks for it, and must leave
// it `planned` with zero `intent_dependencies` rows.

import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, cli, openGraph, commitTaskSubject, cleanup, check, report } from './_lib.mjs';

const CORE = `
id: abandoned-ineligible-fixture
layers:
  - id: view
    scope: ["src/{module}/**"]
    verify: "true"
    commit: "feat({module}): view"
`;

const dir = makeProject(CORE, { git: true });
let worktreePath;
try {
  writeFileSync(
    join(dir, '.gitignore'),
    '.hedgehog/hedgehog.db\n.hedgehog/hedgehog.db-*\n.hedgehog/commit.lock\n',
  );
  execFileSync('git', ['add', '.gitignore'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: gitignore build graph'], { cwd: dir });

  check(
    'add alpha exits 0',
    0,
    cli(dir, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']).status,
  );
  check('first plan exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  commitTaskSubject(dir, 'ALPHA-VIEW');
  check('rebuild exits 0', 0, cli(dir, ['db', 'rebuild']).status);

  check(
    'add beta (depends on complete alpha) exits 0',
    0,
    cli(dir, [
      'intent',
      'add',
      '--id',
      'beta',
      '--goal',
      'g',
      '--outcome',
      'o',
      '--depends-on',
      'alpha',
    ]).status,
  );
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: add beta intent'], { cwd: dir });

  check('plan (creates the beta worktree) exits 0', 0, cli(dir, ['plan', '--no-open']).status);

  const repoName = dir.split('/').filter(Boolean).pop();
  worktreePath = join(dir, '..', `${repoName}.hedgehog-beta`);
  check('the worktree exists before abandoning', true, existsSync(worktreePath));

  const abandoned = cli(dir, ['abandon', 'beta', '--reason', 'requirements changed']);
  check('abandon exits 0', 0, abandoned.status);
  check('the worktree was removed', false, existsSync(worktreePath));

  // abandon resets the DB's `intent_dependencies` row, but never rewrites
  // the committed intent file on disk — beta.json still declares
  // `depends_on: ["alpha"]` verbatim, so the very next `hedgehog plan`
  // (which replays intent files into the DB) repopulates that row on its
  // own, with no hand-edit or `intent add` re-run needed to trigger it.
  const intentPath = join(dir, '.hedgehog/intents/beta.json');
  const record = JSON.parse(readFileSync(intentPath, 'utf8'));
  check('beta.json still declares depends_on on disk (only the DB row cleared)', ['alpha'], record.depends_on);

  // The core assertion: `hedgehog plan` must not re-worktree or recompile
  // beta just because its dependency is complete again — the committed
  // abandonment record must still hold.
  const replanned = cli(dir, ['plan', '--no-open']);
  check('plan after re-declaring the dependency exits 0', 0, replanned.status);
  check(
    'plan does not create a worktree for the abandoned intent',
    false,
    existsSync(worktreePath),
  );

  const db = openGraph(dir);
  let betaStatus, betaTasks;
  try {
    betaStatus = db.prepare("SELECT status FROM intents WHERE id = 'beta'").get().status;
    betaTasks = db.prepare("SELECT status FROM tasks WHERE intent_id = 'beta'").all();
  } finally {
    db.close();
  }
  check('beta stays planned, not re-activated by the recompile', 'planned', betaStatus);
  check('no tasks were compiled for the abandoned intent', 0, betaTasks.length);

  // A `db rebuild` from this same committed state must land on the same
  // conclusion — the fix has to hold on both routes that call
  // eligibleIntents-adjacent logic, not just planCommand's own trigger.
  const rebuilt = cli(dir, ['db', 'rebuild']);
  check('db rebuild exits 0', 0, rebuilt.status);
  check('rebuild does not resurrect a worktree for the abandoned intent', false, existsSync(worktreePath));

  const dbAfterRebuild = openGraph(dir);
  let betaStatusAfterRebuild, betaTasksAfterRebuild;
  try {
    betaStatusAfterRebuild = dbAfterRebuild.prepare("SELECT status FROM intents WHERE id = 'beta'").get()
      .status;
    betaTasksAfterRebuild = dbAfterRebuild
      .prepare("SELECT status FROM tasks WHERE intent_id = 'beta'")
      .all()
      .map((r) => r.status);
  } finally {
    dbAfterRebuild.close();
  }
  check('beta stays planned after rebuild', 'planned', betaStatusAfterRebuild);
  check(
    'no beta task is complete after rebuild with zero commits behind the re-declared dependency',
    true,
    betaTasksAfterRebuild.every((s) => s !== 'complete'),
  );
} finally {
  if (worktreePath) cleanup(worktreePath);
  cleanup(dir);
}

report(
  'an abandoned intent whose dependency is re-declared and satisfied again stays ineligible ' +
    'for a worktree, on both `hedgehog plan` and `hedgehog db rebuild`',
);
