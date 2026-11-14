// Friction logged inside a worktree is an untracked record file there, and
// verify never commits it. `hedgehog merge` carries it into trunk before
// removing the worktree, so trunk lists it and the worktree is still
// removed. `hedgehog abandon` does the same: friction is about the process,
// not the dropped code.

import { existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, cli, commitTaskSubject, cleanup, check, checkContains, report } from './_lib.mjs';

const CORE = `
id: merge-fixture
layers:
  - id: view
    scope: ["src/{module}/**"]
    verify: "true"
    commit: "feat({module}): view"
`;

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

const dir = makeProject(CORE, { git: true });
const repoName = dir.split('/').filter(Boolean).pop();
const betaPath = join(dir, '..', `${repoName}.hedgehog-beta`);
const gammaPath = join(dir, '..', `${repoName}.hedgehog-gamma`);
try {
  writeFileSync(join(dir, '.gitignore'), '.hedgehog/hedgehog.db\n.hedgehog/hedgehog.db-*\n.hedgehog/commit.lock\n');
  git(dir, ['add', '.gitignore']);
  git(dir, ['commit', '-q', '-m', 'chore: gitignore build graph']);

  check('add alpha exits 0', 0, cli(dir, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']).status);
  check('plan exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  commitTaskSubject(dir, 'ALPHA-VIEW');
  check('rebuild exits 0', 0, cli(dir, ['db', 'rebuild']).status);

  for (const id of ['beta', 'gamma']) {
    check(
      `add ${id} exits 0`,
      0,
      cli(dir, ['intent', 'add', '--id', id, '--goal', 'g', '--outcome', 'o', '--depends-on', 'alpha']).status,
    );
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'chore: add beta and gamma intents']);
  check('plan (creates the worktrees) exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  check('the beta worktree exists', true, existsSync(betaPath));
  check('the gamma worktree exists', true, existsSync(gammaPath));

  check(
    'friction add inside the beta worktree exits 0',
    0,
    cli(betaPath, ['friction', 'add', 'beta hit a snag', '--task', 'BETA-VIEW']).status,
  );
  check(
    'friction add inside the gamma worktree exits 0',
    0,
    cli(gammaPath, ['friction', 'add', 'gamma was the wrong idea']).status,
  );

  commitTaskSubject(betaPath, 'BETA-VIEW');
  check('rebuild inside the beta worktree exits 0', 0, cli(betaPath, ['db', 'rebuild']).status);

  const merged = cli(dir, ['merge', 'beta']);
  check('merge exits 0', 0, merged.status);
  check('the beta worktree is removed', false, existsSync(betaPath));
  checkContains('trunk lists the friction logged in the merged worktree', cli(dir, ['friction', 'list']).stdout, 'beta hit a snag');

  const abandoned = cli(dir, ['abandon', 'gamma', '--reason', 'dropped']);
  check('abandon exits 0', 0, abandoned.status);
  check('the gamma worktree is removed', false, existsSync(gammaPath));
  checkContains(
    'trunk lists the friction logged in the abandoned worktree',
    cli(dir, ['friction', 'list']).stdout,
    'gamma was the wrong idea',
  );
} finally {
  for (const path of [betaPath, gammaPath]) if (existsSync(path)) cleanup(path);
  cleanup(dir);
}

report('friction logged in a worktree reaches trunk on merge and on abandon');
