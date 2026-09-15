// Issue #435, second acceptance criterion: "`hedgehog reconcile` can
// detect and propose closing a task whose completing commit exists on
// another branch/worktree."
//
// reconcile.mjs#commitsSince now scans `--all` rather than the bare `HEAD`
// ref (see its own updated comment), so `gatherEvidence`'s window reaches
// a hand-written commit that landed on a DIFFERENT branch than the one
// `hedgehog reconcile` is run from — not only ones on the current branch.
//
// Setup: a module-axis intent, alpha, planned on trunk. alpha's own
// worktree is never created here (alpha has no intent_dependencies, so
// it's never worktree-eligible) — instead, a SEPARATE worktree
// (unrelated-work) is checked out by hand on its own branch, and the
// hand-written commit that satisfies ALPHA-SCHEMA's scope is made THERE,
// not on trunk and not through `hedgehog verify`. `hedgehog reconcile`,
// run back on trunk, must still propose ALPHA-SCHEMA — the commit is
// reachable only via `git log --all`, never via trunk's own `git log`.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, cli, taskStatuses, cleanup, check, checkContains, report } from './_lib.mjs';

const CORE = `
id: cross-branch-reconcile-fixture
layers:
  - id: schema
    scope: ["libs/{module}/schema/**"]
    verify: "true"
    commit: "feat({module}): schema"
`;

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}

const dir = makeProject(CORE, { git: true });
const otherBranchPath = join(dir, '..', `${dir.split('/').filter(Boolean).pop()}.other-branch`);
try {
  check('add alpha exits 0', 0, cli(dir, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']).status);
  check('plan exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  check('ALPHA-SCHEMA starts open', true, ['planned', 'ready'].includes(taskStatuses(dir)['ALPHA-SCHEMA']));

  // A plain (non-`hedgehog/*`) git worktree on its own branch — this
  // doesn't have to be a Hedgehog-created worktree at all; the fix reaches
  // any local branch, which is exactly why `--all` rather than a
  // Hedgehog-specific ref pattern is the right widening.
  git(dir, ['worktree', 'add', '-b', 'someone-elses-branch', otherBranchPath]);

  // The hand-written work, committed on that OTHER branch, never on trunk.
  mkdirSync(join(otherBranchPath, 'libs/alpha/schema'), { recursive: true });
  writeFileSync(join(otherBranchPath, 'libs/alpha/schema/model.txt'), 'written on a different branch\n');
  git(otherBranchPath, ['add', '-A']);
  git(otherBranchPath, ['commit', '-q', '-m', 'add alpha schema on someone-elses-branch']);

  // Trunk's own `git log` never sees that commit.
  const trunkLog = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' });
  check(
    "the hand-written commit is not on trunk's own branch",
    false,
    trunkLog.includes('add alpha schema on someone-elses-branch'),
  );

  // Before the fix, `hedgehog reconcile` on trunk would only ever scan
  // trunk's own `git log` and see nothing. After the fix, `commitsSince`
  // scans `--all` and finds it.
  const proposal = cli(dir, ['reconcile']);
  check('reconcile on trunk exits 0', 0, proposal.status);
  checkContains(
    'reconcile on trunk proposes ALPHA-SCHEMA from a commit on a different branch',
    proposal.stdout,
    'ALPHA-SCHEMA',
  );
  checkContains(
    'reconcile names the in-scope path from the other branch\'s commit',
    proposal.stdout,
    'libs/alpha/schema/model.txt',
  );

  // Confirming it works exactly as it does for a same-branch hand-written
  // commit — reconcile.mjs's confirm path is untouched by this fix.
  const confirmed = cli(dir, [
    'reconcile', 'confirm', 'ALPHA-SCHEMA', '--reason', 'the schema landed on a different branch',
  ]);
  check('reconcile confirm exits 0', 0, confirmed.status);
  check('ALPHA-SCHEMA is complete', 'complete', taskStatuses(dir)['ALPHA-SCHEMA']);
} finally {
  git(dir, ['worktree', 'remove', '--force', otherBranchPath]);
  cleanup(dir);
}

report('hedgehog reconcile proposes a task whose completing commit exists only on a different branch (#435)');
