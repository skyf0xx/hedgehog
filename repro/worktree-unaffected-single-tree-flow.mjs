// Acceptance criterion: "Existing single-working-tree flow is unchanged —
// withCommitLock, claims, and scope gating behave exactly as before."
//
// worktree.mjs#eligibleIntents requires an intent to DECLARE at least one
// `intent_dependencies` row before it is ever considered — an intent with
// none is never "vacuously eligible" the moment it's proposed. This
// reproduces the guarantee end to end on a project that never uses
// --depends-on at all: several intents, normal claim/verify traffic,
// zero worktrees ever created, and the full claim -> verify -> complete
// cycle behaving exactly as it does without this feature.

import { execFileSync } from 'node:child_process';
import {
  makeProject,
  addIntent,
  cli,
  openGraph,
  cleanup,
  check,
  report,
} from './_lib.mjs';

const CORE = `
id: unaffected-fixture
layers:
  - id: schema
    scope: ["src/{module}/schema.txt"]
    verify: "true"
    commit: "feat({module}): schema"
  - id: service
    depends_on: schema
    scope: ["src/{module}/service.txt"]
    verify: "true"
    commit: "feat({module}): service"
`;

const dir = makeProject(CORE, { git: true });
try {
  addIntent(dir, 'orders');
  addIntent(dir, 'billing');
  addIntent(dir, 'search');

  const planned = cli(dir, ['plan', '--no-open']);
  check('plan exits 0', 0, planned.status);
  check('plan compiled all three intents (no worktree deferral)', true, planned.stdout.includes('3 intent(s) compiled'));

  const noWorktreeMention = !planned.stdout.includes('worktree') && !planned.stdout.includes('pending');
  check('plan output never mentions worktrees for a project with no intent_dependencies', true, noWorktreeMention);

  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' });
  check('git worktree list shows only the main worktree', 1, worktrees.trim().split('\n').length);

  const db1 = openGraph(dir);
  let taskCount;
  try {
    taskCount = db1.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  } finally {
    db1.close();
  }
  check('every intent\'s tasks compiled straight onto trunk', 6, taskCount);

  // Ordinary claim -> verify traffic, exactly as it works without this
  // feature: claim a batch, verify each one, watch it complete.
  const claimed = cli(dir, ['claim', '--owner', 'alice', '--count', '3']);
  check('claim exits 0', 0, claimed.status);

  const db2 = openGraph(dir);
  let building;
  try {
    building = db2.prepare("SELECT id FROM tasks WHERE status = 'building'").all().map((r) => r.id);
  } finally {
    db2.close();
  }
  check('three schema-layer tasks claimed (one per intent, none conflict)', 3, building.length);

  for (const taskId of building) {
    const verified = cli(dir, ['verify', taskId, '--owner', 'alice']);
    check(`verify ${taskId} exits 0`, 0, verified.status);
  }

  const db3 = openGraph(dir);
  let completeCount;
  try {
    completeCount = db3.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'complete'").get().n;
  } finally {
    db3.close();
  }
  check('all three schema tasks verified complete', 3, completeCount);

  // The commit lock file is engine-internal and gitignored; its mere
  // presence/absence isn't itself informative once verify has finished
  // (it's created and removed within one call) — the real assertion is
  // that verify succeeded above with no lock contention or leftover lock.
  const lockExists = execFileSync('sh', ['-c', 'test -f .hedgehog/commit.lock && echo yes || echo no'], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  check('the commit lock is released after verify (single working tree, as always)', 'no', lockExists);

  // No worktree was ever created for anything at any point in this run.
  const finalWorktrees = execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' });
  check('still only the main worktree at the end of the run', 1, finalWorktrees.trim().split('\n').length);
} finally {
  cleanup(dir);
}

report('a project with no declared intent_dependencies never triggers worktree creation; single-tree flow unaffected');
