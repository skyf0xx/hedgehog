// `hedgehog db rebuild` (rebuild.mjs) must exclude an intent whose
// worktree is still open (not yet merged or abandoned) from trunk's
// compile, the same way `hedgehog plan` (bin/cli.mjs#planCommand) already
// does via planTasks's `excludeIntentIds`. Without this, running
// `hedgehog db rebuild` directly on trunk while a worktree-eligible
// intent's worktree is still open silently recompiles that intent's tasks
// onto trunk too — two divergent copies of the same intent's tasks
// (planned on trunk, possibly complete in the worktree) with no
// reconciliation path.
//
// This exercises `db rebuild` directly, not through `hedgehog merge` (merge
// already only rebuilds after removing the *specific* worktree it just
// merged — a different intent's still-open worktree is the case that
// matters here).

import { existsSync, writeFileSync } from 'node:fs';
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
id: rebuild-excludes-open-fixture
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

  check('add alpha exits 0', 0, cli(dir, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']).status);
  check('first plan exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  commitTaskSubject(dir, 'ALPHA-VIEW');
  check('rebuild after alpha commit exits 0', 0, cli(dir, ['db', 'rebuild']).status);

  check(
    'add beta (depends on complete alpha) exits 0',
    0,
    cli(dir, ['intent', 'add', '--id', 'beta', '--goal', 'g', '--outcome', 'o', '--depends-on', 'alpha']).status,
  );
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: add beta intent'], { cwd: dir });

  check('plan (creates the beta worktree) exits 0', 0, cli(dir, ['plan', '--no-open']).status);

  const repoName = dir.split('/').filter(Boolean).pop();
  worktreePath = join(dir, '..', `${repoName}.hedgehog-beta`);
  check('the worktree exists', true, existsSync(worktreePath));

  // Trunk never compiled beta's tasks — confirm the starting state.
  const before = openGraph(dir);
  let betaBefore;
  try {
    betaBefore = before.prepare("SELECT id FROM tasks WHERE intent_id = 'beta'").all();
  } finally {
    before.close();
  }
  check('trunk has no beta tasks before rebuild', 0, betaBefore.length);

  // The bug: running `db rebuild` directly on trunk, with beta's worktree
  // still open, must not recompile beta's tasks onto trunk.
  const rebuild = cli(dir, ['db', 'rebuild']);
  check('db rebuild on trunk exits 0 while a worktree is open', 0, rebuild.status);

  const after = openGraph(dir);
  let betaAfter;
  try {
    betaAfter = after.prepare("SELECT id FROM tasks WHERE intent_id = 'beta'").all();
  } finally {
    after.close();
  }
  check(
    'trunk still has no beta tasks after `hedgehog db rebuild` while beta\'s worktree is open',
    0,
    betaAfter.length,
  );

  // beta's own worktree graph is unaffected — it still has its own tasks.
  const worktreeDb = openGraph(worktreePath);
  let betaInWorktree;
  try {
    betaInWorktree = worktreeDb.prepare("SELECT id FROM tasks WHERE intent_id = 'beta'").all();
  } finally {
    worktreeDb.close();
  }
  check('beta\'s own worktree graph still has its tasks', 1, betaInWorktree.length);
} finally {
  if (worktreePath) cleanup(worktreePath);
  cleanup(dir);
}

report('hedgehog db rebuild on trunk excludes an intent whose worktree is still open');
