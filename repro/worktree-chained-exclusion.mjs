// `hedgehog plan` must not crash when a pending intent depends on a
// worktree-excluded intent. planTasks's `excludeIntentIds` (worktree.mjs's
// eligibleIntents feeds this) filters which intents get compiled onto
// trunk, but the cross-intent edge-insertion loop still walks every
// `intent_dependencies` row belonging to a compiling intent — so an
// intent C that `--depends-on` an excluded intent B, but is not itself
// eligible for a worktree yet (its own dependency B is not `complete`),
// would otherwise still compile onto trunk and try to INSERT a
// `dependencies` row onto one of B's task ids, which was never inserted
// anywhere (B's tasks exist only in B's own worktree, once it gets one).
// `dependencies.depends_on_task_id` is a FOREIGN KEY with no bypass
// (schema.mjs, `foreign_keys = ON`), so that INSERT throws and aborts the
// whole `hedgehog plan` transaction.
//
// The realistic shape: alpha completes; beta (`--depends-on alpha`)
// becomes worktree-eligible and is excluded from trunk; gamma
// (`--depends-on beta`) is declared at the same time but is NOT eligible
// for its own worktree yet (beta isn't complete) — gamma must also stay
// off trunk until beta finishes, the same way eligibleIntents already
// requires a dependency to be complete before its dependent proceeds.

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
id: chained-exclusion-fixture
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

  // beta depends on the now-complete alpha — worktree-eligible.
  check(
    'add beta (depends on complete alpha) exits 0',
    0,
    cli(dir, ['intent', 'add', '--id', 'beta', '--goal', 'g', '--outcome', 'o', '--depends-on', 'alpha']).status,
  );
  // gamma depends on beta, which is NOT complete — gamma must not compile
  // onto trunk either, since beta's tasks don't exist there.
  check(
    'add gamma (depends on not-yet-complete beta) exits 0',
    0,
    cli(dir, ['intent', 'add', '--id', 'gamma', '--goal', 'g', '--outcome', 'o', '--depends-on', 'beta']).status,
  );
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: add beta and gamma intents'], { cwd: dir });

  // This is the crash repro: beta gets excluded (worktree-eligible) and
  // gamma, depending on beta, must not blow up the transaction with a
  // dangling FK insert.
  const plan = cli(dir, ['plan', '--no-open']);
  check('plan does not crash when a pending intent depends on an excluded one', 0, plan.status);

  const repoName = dir.split('/').filter(Boolean).pop();
  worktreePath = join(dir, '..', `${repoName}.hedgehog-beta`);
  check('a worktree was created for beta', true, existsSync(worktreePath));

  const db = openGraph(dir);
  let betaOnTrunk, gammaOnTrunk;
  try {
    betaOnTrunk = db.prepare("SELECT id FROM tasks WHERE intent_id = 'beta'").all();
    gammaOnTrunk = db.prepare("SELECT id FROM tasks WHERE intent_id = 'gamma'").all();
  } finally {
    db.close();
  }
  check('beta was not compiled onto trunk', 0, betaOnTrunk.length);
  // gamma must also stay uncompiled on trunk — it depends on beta, whose
  // tasks live only in beta's own worktree, not on trunk.
  check('gamma was not compiled onto trunk either (depends on excluded beta)', 0, gammaOnTrunk.length);

  // Complete beta inside its own worktree and merge it back. `hedgehog
  // merge`'s own rebuild compiles gamma straight onto trunk in the same
  // pass that marks beta complete — merge never re-runs the worktree
  // eligibility trigger (only `hedgehog plan` does that), so a
  // newly-eligible dependent is not itself worktree'd until a later
  // `hedgehog plan` — but by then it already has trunk-compiled tasks and
  // `planTasks` treats it as already-compiled. What matters here is what
  // this repro exists to prove: gamma's edge to beta never causes a
  // dangling-FK crash, whichever side of that boundary it lands on.
  commitTaskSubject(worktreePath, 'BETA-VIEW');
  check('rebuild inside beta\'s worktree exits 0', 0, cli(worktreePath, ['db', 'rebuild']).status);
  const mergeResult = cli(dir, ['merge', 'beta']);
  check('merge beta exits 0', 0, mergeResult.status);
  worktreePath = null; // merge removed it

  const dbAfterMerge = openGraph(dir);
  let gammaAfterMerge;
  try {
    gammaAfterMerge = dbAfterMerge.prepare("SELECT id, status FROM tasks WHERE intent_id = 'gamma'").all();
  } finally {
    dbAfterMerge.close();
  }
  check(
    'gamma compiled onto trunk once beta (its dependency) completed, with no crash',
    [{ id: 'GAMMA-VIEW', status: 'planned' }],
    gammaAfterMerge,
  );

  // A further `hedgehog plan` is a clean no-op — gamma is already
  // compiled, not re-triggered into its own worktree.
  const secondPlan = cli(dir, ['plan', '--no-open']);
  check('second plan exits 0', 0, secondPlan.status);
  const repoName2 = dir.split('/').filter(Boolean).pop();
  const gammaWorktreePath = join(dir, '..', `${repoName2}.hedgehog-gamma`);
  check('no separate worktree is created for gamma (already compiled onto trunk)', false, existsSync(gammaWorktreePath));
} finally {
  if (worktreePath) cleanup(worktreePath);
  cleanup(dir);
}

report('hedgehog plan does not crash when a pending intent transitively depends on a worktree-excluded intent');
