// `hedgehog merge <intent-id>` — merges the intent's worktree branch into
// trunk with `git merge --no-ff`, rebuilds trunk's graph, removes the
// worktree and branch. Refuses first if the intent's tasks are not all
// `complete` in the worktree's own graph. On success, trunk's rebuilt
// graph shows those tasks `complete` with no separate DB merge step — the
// whole point of the design (worktree.mjs, rebuild.mjs's file header).

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
id: merge-fixture
layers:
  - id: view
    scope: ["src/{module}/**"]
    verify: "true"
    commit: "feat({module}): view"
`;

const dir = makeProject(CORE, { git: true });
let worktreePath;
try {
  // A real `hedgehog init` writes .gitignore covering .hedgehog/hedgehog.db*
  // (bin/cli.mjs's GITIGNORE_ENTRIES) — this fixture project is hand-built
  // by makeProject rather than through init, so without this the DB file
  // itself gets tracked by the `git add -A` calls below, and `git worktree
  // remove` (correctly) refuses to delete a worktree with a modified
  // tracked file in it. Every real Hedgehog project has this covered
  // already; this repro adds it explicitly since its fixture doesn't.
  writeFileSync(
    join(dir, '.gitignore'),
    '.hedgehog/hedgehog.db\n.hedgehog/hedgehog.db-*\n.hedgehog/commit.lock\n',
  );
  execFileSync('git', ['add', '.gitignore'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: gitignore build graph'], { cwd: dir });


  check('add alpha exits 0', 0, cli(dir, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']).status);
  check('first plan exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  commitTaskSubject(dir, 'ALPHA-VIEW');
  check('rebuild exits 0', 0, cli(dir, ['db', 'rebuild']).status);

  check(
    'add beta (depends on complete alpha) exits 0',
    0,
    cli(dir, ['intent', 'add', '--id', 'beta', '--goal', 'g', '--outcome', 'o', '--depends-on', 'alpha']).status,
  );
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: add beta intent'], { cwd: dir });

  // merge with an incomplete worktree graph refuses first.
  const planForWorktree = cli(dir, ['plan', '--no-open']);
  check('plan (creates the worktree) exits 0', 0, planForWorktree.status);

  const repoName = dir.split('/').filter(Boolean).pop();
  worktreePath = join(dir, '..', `${repoName}.hedgehog-beta`);
  check('the worktree exists', true, existsSync(worktreePath));

  const refuseIncomplete = cli(dir, ['merge', 'beta']);
  check('merge refuses while beta\'s task is not complete', 1, refuseIncomplete.status);
  check(
    'merge names the incomplete task',
    true,
    refuseIncomplete.stderr.includes('BETA-VIEW') || refuseIncomplete.stdout.includes('BETA-VIEW'),
  );

  const worktreesStillThere = execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' });
  check('the worktree is untouched after a refused merge', true, worktreesStillThere.includes('hedgehog/beta'));

  // Complete beta's task inside its own worktree — a real commit there,
  // exactly like a real `hedgehog verify` run would leave, then rebuild
  // that worktree's own graph so its own DB reflects it.
  commitTaskSubject(worktreePath, 'BETA-VIEW');
  const worktreeRebuild = cli(worktreePath, ['db', 'rebuild']);
  check('rebuild inside the worktree exits 0', 0, worktreeRebuild.status);

  const worktreeDb = openGraph(worktreePath);
  let betaStatusInWorktree;
  try {
    betaStatusInWorktree = worktreeDb.prepare("SELECT status FROM tasks WHERE id = 'BETA-VIEW'").get().status;
  } finally {
    worktreeDb.close();
  }
  check('beta task is complete in the worktree\'s own graph', 'complete', betaStatusInWorktree);

  // Trunk's own graph has never heard of BETA-VIEW at all — proving the
  // merge step, not a prior compile, is what makes it show up.
  const trunkBefore = openGraph(dir);
  let betaOnTrunkBefore;
  try {
    betaOnTrunkBefore = trunkBefore.prepare("SELECT id FROM tasks WHERE id = 'BETA-VIEW'").all();
  } finally {
    trunkBefore.close();
  }
  check('trunk has no BETA-VIEW row before the merge', 0, betaOnTrunkBefore.length);

  const merged = cli(dir, ['merge', 'beta']);
  check('merge succeeds once beta is complete in its own worktree', 0, merged.status);

  // No separate "DB merge" step — git merged the sources (the intent
  // file, the commit whose subject matches BETA-VIEW's commit_message),
  // and `hedgehog db rebuild` (run by merge itself) re-derived the rest.
  const trunkAfter = openGraph(dir);
  let betaOnTrunkAfter;
  try {
    betaOnTrunkAfter = trunkAfter.prepare("SELECT id, status FROM tasks WHERE id = 'BETA-VIEW'").get();
  } finally {
    trunkAfter.close();
  }
  check('trunk\'s rebuilt graph shows BETA-VIEW complete', { id: 'BETA-VIEW', status: 'complete' }, betaOnTrunkAfter);

  const worktreesAfterMerge = execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' });
  check('the worktree was removed after a successful merge', false, worktreesAfterMerge.includes('hedgehog/beta'));
  check('the worktree directory itself is gone', false, existsSync(worktreePath));

  const branches = execFileSync('git', ['branch', '--list', 'hedgehog/*'], { cwd: dir, encoding: 'utf8' });
  check('the branch was removed too', '', branches.trim());

  // Merging an intent with no worktree at all is a clear refusal, not a
  // crash.
  const noWorktree = cli(dir, ['merge', 'nonexistent']);
  check('merging an intent with no worktree refuses', 1, noWorktree.status);
} finally {
  if (worktreePath) cleanup(worktreePath);
  cleanup(dir);
}

report('hedgehog merge fails on incomplete work and closes complete work with no separate DB merge step');
