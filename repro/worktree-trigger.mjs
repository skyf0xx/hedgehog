// `hedgehog plan` creates a `git worktree` for a pending intent the
// instant its `intent_dependencies` are all `complete` — never for an
// intent whose dependency is still open, and never for an intent that
// declares no `intent_dependencies` at all (that last rule is what keeps
// the existing single-working-tree flow unchanged for a project that
// never uses the feature — see worktree.mjs#eligibleIntents).
//
// The realistic shape this reproduces: `alpha` is added and built to
// completion first — a Re-entry-style addition (see plan.mjs's own
// comments on the same shape for once-layers), which is exactly how a
// second intent gets declared *after* its dependency already exists and
// (later) completes, rather than both being declared up front. `beta` is
// then added, already depending on the now-complete `alpha` — the same
// `--depends-on` mechanism `05-shipped-cores-unchanged.mjs` exercises
// with both intents' dependency still open (a scenario this feature
// deliberately never touches: an intent whose dependency was open at
// `plan` time compiles onto trunk exactly as it always has, edges and
// all, unaffected by this feature — worktree eligibility only ever
// applies going forward, to an intent not yet compiled anywhere).

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
id: worktree-fixture
layers:
  - id: view
    scope: ["src/{module}/**"]
    verify: "true"
    commit: "feat({module}): view"
`;

const dir = makeProject(CORE, { git: true });
try {
  // See worktree-merge.mjs for why: a real `hedgehog init` writes this;
  // this hand-built fixture doesn't, and without it the DB file gets
  // tracked by the `git add -A` calls below.
  writeFileSync(
    join(dir, '.gitignore'),
    '.hedgehog/hedgehog.db\n.hedgehog/hedgehog.db-*\n.hedgehog/commit.lock\n',
  );
  execFileSync('git', ['add', '.gitignore'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: gitignore build graph'], { cwd: dir });

  check('add alpha exits 0', 0, cli(dir, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']).status);

  // First plan: alpha has no declared dependency, so it compiles straight
  // onto trunk exactly as it always has.
  const firstPlan = cli(dir, ['plan', '--no-open']);
  check('first plan exits 0', 0, firstPlan.status);

  const db1 = openGraph(dir);
  let alphaTasks;
  try {
    alphaTasks = db1.prepare("SELECT id FROM tasks WHERE intent_id = 'alpha'").all();
  } finally {
    db1.close();
  }
  check('alpha compiled onto trunk (no declared dependency)', 1, alphaTasks.length);

  // Complete alpha's task the same way `hedgehog verify` would credit it —
  // a real commit whose subject matches commit_message.
  commitTaskSubject(dir, 'ALPHA-VIEW');
  const rebuild1 = cli(dir, ['db', 'rebuild']);
  check('rebuild after alpha commit exits 0', 0, rebuild1.status);

  const db2 = openGraph(dir);
  let alphaStatus;
  try {
    alphaStatus = db2.prepare("SELECT status FROM tasks WHERE id = 'ALPHA-VIEW'").get().status;
  } finally {
    db2.close();
  }
  check('alpha task is complete on trunk', 'complete', alphaStatus);

  // beta is only declared now, already depending on the complete alpha —
  // the realistic "next unit of work, once the prerequisite landed" shape.
  check(
    'add beta (depends on already-complete alpha) exits 0',
    0,
    cli(dir, [
      'intent', 'add', '--id', 'beta', '--goal', 'g', '--outcome', 'o', '--depends-on', 'alpha',
    ]).status,
  );

  const worktreesBeforeSecond = execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' });
  check('no worktree exists for beta yet', false, worktreesBeforeSecond.includes('hedgehog/beta'));

  // `intent add` writes the file but does not commit it (the loop skills'
  // own job) — a `git worktree add` right now would check out a branch
  // with no intent file inside it, since a worktree only ever sees what
  // HEAD already has committed. `hedgehog plan` has to recognize this and
  // defer rather than create a broken worktree or fall back to compiling
  // beta onto trunk.
  const planBeforeCommit = cli(dir, ['plan', '--no-open']);
  check('plan before the intent file is committed exits 0', 0, planBeforeCommit.status);
  check(
    'plan reports beta as pending on the commit, not worktreed',
    true,
    planBeforeCommit.stdout.includes('pending') && planBeforeCommit.stdout.includes('BETA'),
  );
  const worktreesStillNone = execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' });
  check('still no worktree for beta before the commit', false, worktreesStillNone.includes('hedgehog/beta'));
  const dbNoTrunkCompile = openGraph(dir);
  let betaStillUncompiled;
  try {
    betaStillUncompiled = dbNoTrunkCompile.prepare("SELECT id FROM tasks WHERE intent_id = 'beta'").all();
  } finally {
    dbNoTrunkCompile.close();
  }
  check('beta still not compiled onto trunk while its file is uncommitted', 0, betaStillUncompiled.length);

  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: add beta intent'], { cwd: dir });

  // Second plan: beta's one declared dependency is already complete, and
  // its intent file is now committed — this is the trigger. beta gets its
  // own worktree + branch, and its tasks compile only inside that
  // worktree, never on trunk.
  const secondPlan = cli(dir, ['plan', '--no-open']);
  check('second plan exits 0', 0, secondPlan.status);
  check('second plan reports the new worktree', true, secondPlan.stdout.includes('BETA'));

  const worktreesAfterSecond = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: dir,
    encoding: 'utf8',
  });
  check('a worktree now exists for beta', true, worktreesAfterSecond.includes('refs/heads/hedgehog/beta'));

  const db3 = openGraph(dir);
  let betaOnTrunk;
  try {
    betaOnTrunk = db3.prepare("SELECT id FROM tasks WHERE intent_id = 'beta'").all();
  } finally {
    db3.close();
  }
  check('beta was NOT compiled onto trunk\'s own graph', 0, betaOnTrunk.length);

  // The worktree path is a sibling of the repo, never nested inside it.
  const repoName = dir.split('/').filter(Boolean).pop();
  const worktreePath = join(dir, '..', `${repoName}.hedgehog-beta`);
  check('the worktree directory exists', true, existsSync(worktreePath));
  check('the worktree is a sibling, not nested inside the repo', false, worktreePath.startsWith(dir + '/'));

  const worktreeDb = openGraph(worktreePath);
  let betaInWorktree;
  try {
    betaInWorktree = worktreeDb.prepare("SELECT id, status FROM tasks WHERE intent_id = 'beta'").all();
  } finally {
    worktreeDb.close();
  }
  check(
    'beta compiled inside its own worktree\'s graph, status planned',
    [{ id: 'BETA-VIEW', status: 'planned' }],
    betaInWorktree,
  );

  // Cleanup: kill any graph server the nested `plan` spawned inside the
  // worktree, then remove both directories.
  cleanup(worktreePath);
} finally {
  cleanup(dir);
}

report('hedgehog plan worktrees an intent only once its declared intent_dependencies clear');
