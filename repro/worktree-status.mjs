// `hedgehog status` lists active worktrees and flags orphaned ones —
// branch or directory gone with no merged/abandoned record
// (worktree.mjs#worktreeStatus, status.mjs's WORKTREES / ORPHANED
// WORKTREES sections).

import { existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  makeProject,
  cli,
  commitTaskSubject,
  cleanup,
  check,
  report,
} from './_lib.mjs';

const CORE = `
id: status-fixture
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
  check('rebuild exits 0', 0, cli(dir, ['db', 'rebuild']).status);

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

  // Active worktree case: status lists it, unflagged.
  const statusWithActive = cli(dir, ['status']);
  check('status exits 0 with an active worktree', 0, statusWithActive.status);
  check('status lists the active worktree', true, statusWithActive.stdout.includes('WORKTREES'));
  check('status names beta\'s branch', true, statusWithActive.stdout.includes('hedgehog/beta'));
  check(
    'status does not flag it as orphaned while it is active',
    false,
    statusWithActive.stdout.includes('ORPHANED WORKTREES'),
  );

  // Orphan case: remove the worktree directory by hand (rm -rf, not
  // `hedgehog merge`/`hedgehog abandon`), leaving the branch behind with
  // no worktree entry and no merged/abandoned record for it.
  execFileSync('rm', ['-rf', worktreePath]);
  // `git worktree list` still has a stale entry until pruned; a real user
  // hitting this would see the same staleness. Prune so hedgehogWorktrees
  // (which reads `git worktree list --porcelain`) reports what's
  // actually on disk, matching a stale-but-unpruned entry's real-world
  // outcome — either way, the branch itself survives, which is the
  // condition worktreeStatus keys off.
  execFileSync('git', ['worktree', 'prune'], { cwd: dir });

  const statusOrphaned = cli(dir, ['status']);
  check('status exits 0 after the worktree directory is gone', 0, statusOrphaned.status);
  check('status no longer lists beta as an active worktree', false, statusOrphaned.stdout.includes('WORKTREES\n  BETA'));
  check('status flags beta as orphaned', true, statusOrphaned.stdout.includes('ORPHANED WORKTREES'));
  check('the orphan line names beta\'s branch', true, statusOrphaned.stdout.includes('hedgehog/beta'));

  // Once abandoned, the leftover branch (abandon already removed the
  // worktree; the branch is gone too in the normal path, but a user who
  // manually recreated it, or a race, could leave one) is no longer
  // reported as an orphan — the abandonment record explains it.
  const abandoned = cli(dir, ['abandon', 'beta', '--reason', 'dropped']);
  check('abandon exits 0 even with no live worktree left', 0, abandoned.status);

  const statusAfterAbandon = cli(dir, ['status']);
  check(
    'status no longer flags beta as orphaned once it is recorded abandoned',
    false,
    statusAfterAbandon.stdout.includes('ORPHANED WORKTREES'),
  );
} finally {
  cleanup(dir);
}

report('hedgehog status lists active worktrees and flags orphaned ones');
