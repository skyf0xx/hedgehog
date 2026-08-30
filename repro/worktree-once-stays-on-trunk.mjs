// `once: true` / core-module tasks (plan.mjs's CORE_INTENT_ID, the
// synthesised intent every once-layer's single task hangs off) have no
// real intent and must never be worktree'd — worktree.mjs#eligibleIntents
// excludes `_core` by id explicitly. This reproduces that a build using
// both once-layers and intent_dependencies still compiles its once-layer
// tasks straight onto trunk, unaffected by a sibling intent's worktree.

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

// cluster (once, head) -> schema (per-intent) -> deploy (once, tail).
const CORE = `
id: once-worktree-fixture
layers:
  - id: cluster
    scope: ["infra/cluster/**"]
    verify: "true"
    once: true
    commit: "chore(infra): cluster"
  - id: schema
    depends_on: cluster
    scope: ["libs/{module}/**"]
    verify: "true"
    commit: "feat({module}): schema"
  - id: deploy
    depends_on: schema
    scope: ["infra/deploy/**"]
    verify: "true"
    once: true
    commit: "chore(infra): deploy"
`;

const dir = makeProject(CORE, { git: true });
try {
  // See worktree-merge.mjs for why: a real `hedgehog init` writes this;
  // this hand-built fixture doesn't.
  writeFileSync(
    join(dir, '.gitignore'),
    '.hedgehog/hedgehog.db\n.hedgehog/hedgehog.db-*\n.hedgehog/commit.lock\n',
  );
  execFileSync('git', ['add', '.gitignore'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: gitignore build graph'], { cwd: dir });

  check('add alpha exits 0', 0, cli(dir, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']).status);
  check('first plan exits 0', 0, cli(dir, ['plan', '--no-open']).status);

  const db1 = openGraph(dir);
  let onceTasks;
  try {
    onceTasks = db1.prepare("SELECT id, intent_id, status FROM tasks WHERE intent_id = '_core' ORDER BY id").all();
  } finally {
    db1.close();
  }
  check(
    'both once-layer tasks compiled onto trunk under the synthesised core intent',
    [
      { id: 'CLUSTER', intent_id: '_core', status: 'planned' },
      { id: 'DEPLOY', intent_id: '_core', status: 'planned' },
    ],
    onceTasks,
  );

  // Complete alpha's whole chain (cluster -> schema -> deploy would need
  // real ordering; here we only need to prove cluster/deploy never move to
  // a worktree, so commit each task's own subject directly).
  commitTaskSubject(dir, 'CLUSTER');
  commitTaskSubject(dir, 'ALPHA-SCHEMA');
  commitTaskSubject(dir, 'DEPLOY');
  check('rebuild exits 0', 0, cli(dir, ['db', 'rebuild']).status);

  // Add a second intent that depends on alpha (now complete) — the
  // ordinary worktree trigger fires for beta, but must never touch the
  // once-layer tasks, which have no intent_dependencies row of their own
  // (their ordering is a plain task dependency edge, not an intent one).
  check(
    'add beta (depends on alpha) exits 0',
    0,
    cli(dir, ['intent', 'add', '--id', 'beta', '--goal', 'g', '--outcome', 'o', '--depends-on', 'alpha']).status,
  );
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: add beta intent'], { cwd: dir });

  const secondPlan = cli(dir, ['plan', '--no-open']);
  check('second plan exits 0', 0, secondPlan.status);

  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  check('beta got its own worktree', true, worktrees.includes('refs/heads/hedgehog/beta'));
  check('no worktree was ever created for the synthesised core intent', false, worktrees.includes('hedgehog/_core'));

  const db2 = openGraph(dir);
  let onceTasksAfter;
  try {
    onceTasksAfter = db2
      .prepare("SELECT id, intent_id FROM tasks WHERE intent_id = '_core' ORDER BY id")
      .all();
  } finally {
    db2.close();
  }
  check(
    'once-layer tasks are still on trunk, still under _core, after a sibling intent worktreed',
    [
      { id: 'CLUSTER', intent_id: '_core' },
      { id: 'DEPLOY', intent_id: '_core' },
    ],
    onceTasksAfter,
  );

  cleanup(`${dir}.hedgehog-beta`);
} finally {
  cleanup(dir);
}

report('once: true / core-module tasks are never worktreed and stay on trunk');
