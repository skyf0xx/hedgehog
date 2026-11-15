// `hedgehog next` and `hedgehog claim` read the same candidate set.
//
// Inside an intent's worktree, a dependency completed on trunk is
// credited through `git log --all` (crossBranch.mjs). `claim` hands out a
// task unblocked that way, so `next` has to name the same task rather
// than report nothing ready.
//
// Sequence: a shared `once` layer (CLUSTER) gates every module's schema
// layer. alpha's worktree opens before CLUSTER completes; CLUSTER then
// completes on trunk. Inside alpha's worktree, its own local CLUSTER copy
// is claimed (so the only remaining candidate is the cross-branch one),
// and `next` must print ALPHA-SCHEMA, the task `claim` then takes.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, cli, taskStatuses, cleanup, check, checkContains, report } from './_lib.mjs';

const CORE = `
id: next-claim-agree-fixture
layers:
  - id: cluster
    scope: ["infra/cluster/**"]
    verify: "true"
    once: true
    commit: "chore(infra): cluster"
  - id: schema
    depends_on: cluster
    scope: ["libs/{module}/schema/**"]
    verify: "true"
    commit: "feat({module}): schema"
`;

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}

const dir = makeProject(CORE, { git: true });
let alphaWorktree;
try {
  check('add beta exits 0', 0, cli(dir, ['intent', 'add', '--id', 'beta', '--goal', 'g', '--outcome', 'o']).status);
  check('plan beta exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  check('reconcile exits 0', 0, cli(dir, ['reconcile']).status);
  check(
    'reconcile confirm BETA-SCHEMA exits 0',
    0,
    cli(dir, ['reconcile', 'confirm', 'BETA-SCHEMA', '--reason', 'closed so alpha is worktree-eligible']).status,
  );
  check(
    'add alpha exits 0',
    0,
    cli(dir, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o', '--depends-on', 'beta']).status,
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'chore: add alpha intent, reconcile beta']);
  check('plan (opens the alpha worktree) exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  alphaWorktree = join(dir, '..', `${dir.split('/').filter(Boolean).pop()}.hedgehog-alpha`);
  check('alpha worktree exists', true, existsSync(alphaWorktree));

  check('claim CLUSTER on trunk exits 0', 0, cli(dir, ['claim', 'CLUSTER', '--owner', 'trunk']).status);
  mkdirSync(join(dir, 'infra', 'cluster'), { recursive: true });
  writeFileSync(join(dir, 'infra', 'cluster', 'config.txt'), 'cluster config\n');
  check('verify CLUSTER on trunk exits 0', 0, cli(dir, ['verify', 'CLUSTER', '--owner', 'trunk']).status);

  check(
    "claim alpha's local CLUSTER copy exits 0",
    0,
    cli(alphaWorktree, ['claim', 'CLUSTER', '--owner', 'alpha-local']).status,
  );

  const next = cli(alphaWorktree, ['next']);
  check('next inside alpha worktree exits 0', 0, next.status);
  checkContains('next inside alpha worktree names ALPHA-SCHEMA', next.stdout, 'ALPHA-SCHEMA');

  check(
    'claim --count 1 inside alpha worktree exits 0',
    0,
    cli(alphaWorktree, ['claim', '--owner', 'alpha-agent', '--count', '1']).status,
  );
  check('claim took the task next named', 'building', taskStatuses(alphaWorktree)['ALPHA-SCHEMA']);
} finally {
  if (alphaWorktree) cleanup(alphaWorktree);
  cleanup(dir);
}

report('`hedgehog next` names the task `hedgehog claim` takes, cross-branch completions included');
