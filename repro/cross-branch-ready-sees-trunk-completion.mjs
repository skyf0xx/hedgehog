// Issue #435: "Intent worktrees don't see task completions from other
// worktrees, and reconcile can't detect them either."
//
// The precise scenario: a SHARED/base layer (a `once: true` layer,
// compiled once for the whole build under the synthesised `_core` intent
// — plan.mjs) is completed on TRUNK strictly AFTER a dependent intent's
// worktree already exists. `once: true` layers never get their own
// worktree (worktree.mjs#eligibleIntents excludes `_core` by id — they
// always build on trunk), so this is exactly the shape the issue names:
// "a task on the SHARED/BASE layer sequence completed on trunk, with a
// sibling intent worktree open, and that worktree's `ready` should
// reflect the base task as complete rather than blocking on it."
//
// Sequence, on a module-axis core with one `once: true` shared layer
// (CLUSTER) gating every module's own schema layer, so every task's
// commit_message is unique to it (the unambiguous case crossBranch.mjs
// fully solves — see its file header for why the ambiguous linear-chain
// core case is a documented, narrower gap):
//
//   1. `beta` has no intent_dependencies, so it is never worktree-eligible
//      — it exists purely so `alpha` has a complete intent to
//      intent-depend on, which is what makes `alpha` worktree-eligible
//      while CLUSTER (a structural, non-intent dependency every module's
//      schema layer carries automatically) is still incomplete.
//   2. `alpha` (depends_on beta) becomes worktree-eligible once beta
//      completes, and gets its own worktree BEFORE CLUSTER is ever
//      completed anywhere — so alpha's worktree branches off a trunk HEAD
//      that has never seen a CLUSTER completion at all, ordinary or
//      cross-branch. ALPHA-SCHEMA is confirmed blocked on CLUSTER inside
//      alpha's own worktree at this point (the honest starting condition).
//   3. CLUSTER is completed exactly once, ON TRUNK, strictly AFTER alpha's
//      worktree already exists. This is alpha's ONLY route to ever seeing
//      CLUSTER complete: no ordinary rebuild inside alpha's worktree can
//      find this commit, because it never existed on alpha's branch at
//      all until this step, and by then alpha's branch has already
//      diverged.
//   4. `hedgehog ready`/`status`/`claim`, run INSIDE alpha's own worktree,
//      must report ALPHA-SCHEMA as claimable — credited purely via
//      crossBranch.mjs's `git log --all`, with no DB row for CLUSTER's
//      completion ever having been written or copied into alpha's own
//      worktree DB.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeProject,
  cli,
  openGraph,
  taskStatuses,
  cleanup,
  check,
  checkContains,
  report,
} from './_lib.mjs';

const CORE = `
id: cross-branch-shared-layer-fixture
layers:
  - id: cluster
    scope: ["infra/cluster/**"]
    verify: "true"
    exclusive: true
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

function repoNameOf(dir) {
  return dir.split('/').filter(Boolean).pop();
}

const dir = makeProject(CORE, { git: true });
let alphaWorktree;
try {
  // beta: no intent_dependencies at all, never worktree-eligible — exists
  // only so alpha has a complete intent to depend on. beta's own
  // BETA-SCHEMA task is left uncompleted (still blocked on CLUSTER, same
  // as every module's schema layer) — it plays no further part.
  check('add beta exits 0', 0, cli(dir, ['intent', 'add', '--id', 'beta', '--goal', 'g', '--outcome', 'o']).status);
  check('plan beta exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  check('CLUSTER is not complete yet', true, taskStatuses(dir)['CLUSTER'] !== 'complete');

  // beta itself never completes (nothing needs it to) — abandon it
  // instead, which is the supported way to close an intent with no
  // shipped work and reset it to `planned` with intent_dependencies
  // cleared. What alpha needs is simply "beta's intent status reads
  // complete", so use reconcile instead: confirm BETA-SCHEMA done by
  // reconciliation, closing beta's intent without ever needing CLUSTER.
  const evidence = cli(dir, ['reconcile']);
  check('reconcile proposal exits 0', 0, evidence.status);
  const confirmed = cli(dir, [
    'reconcile', 'confirm', 'BETA-SCHEMA', '--reason', 'not part of this repro; closed to unblock alpha only',
  ]);
  check('reconcile confirm BETA-SCHEMA exits 0', 0, confirmed.status);
  check('beta intent is complete', 'complete', (() => {
    const db = openGraph(dir);
    try {
      return db.prepare("SELECT status FROM intents WHERE id = 'beta'").get()?.status;
    } finally {
      db.close();
    }
  })());

  // alpha, depends_on beta (now complete) — worktree-eligible immediately,
  // BEFORE CLUSTER has ever been completed anywhere.
  check(
    'add alpha (depends on complete beta) exits 0',
    0,
    cli(dir, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o', '--depends-on', 'beta']).status,
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'chore: add alpha intent, reconcile beta']);
  check('plan (creates the alpha worktree) exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  alphaWorktree = join(dir, '..', `${repoNameOf(dir)}.hedgehog-alpha`);
  check('alpha worktree now exists', true, existsSync(alphaWorktree));

  // The honest starting condition: CLUSTER has never been completed
  // anywhere, so alpha's own worktree correctly blocks ALPHA-SCHEMA on it.
  check(
    "alpha's own worktree DB sees CLUSTER as not complete (never completed anywhere yet)",
    true,
    (() => {
      const db = openGraph(alphaWorktree);
      try {
        return db.prepare("SELECT status FROM tasks WHERE id = 'CLUSTER'").get()?.status !== 'complete';
      } finally {
        db.close();
      }
    })(),
  );
  check(
    "ALPHA-SCHEMA is blocked on CLUSTER inside alpha's own worktree before trunk completes it",
    false,
    cli(alphaWorktree, ['ready']).stdout.includes('ALPHA-SCHEMA'),
  );

  // CLUSTER is completed exactly once, ON TRUNK, strictly AFTER alpha's
  // worktree already branched off — its commit never existed on alpha's
  // branch and cannot be found by any ordinary rebuild run there.
  check('claim CLUSTER on trunk exits 0', 0, cli(dir, ['claim', '--owner', 'trunk-agent', '--count', '1']).status);
  check('CLUSTER is building on trunk', 'building', taskStatuses(dir)['CLUSTER']);
  // A real file inside CLUSTER's own scope: with nothing touched, verify
  // now closes a genuine no-op with no commit at all (noop.mjs) — this
  // test is specifically about a commit's cross-branch visibility, so it
  // needs the ordinary committed path, not the no-op one.
  mkdirSync(join(dir, 'infra', 'cluster'), { recursive: true });
  writeFileSync(join(dir, 'infra', 'cluster', 'config.txt'), 'cluster config\n');
  check('verify CLUSTER on trunk exits 0', 0, cli(dir, ['verify', 'CLUSTER', '--owner', 'trunk-agent']).status);
  check('CLUSTER is complete on trunk', 'complete', taskStatuses(dir)['CLUSTER']);

  // Confirm the shape that makes this the real test: CLUSTER's commit is
  // wholly absent from alpha's own worktree branch history, and reachable
  // only via `--all`.
  const onlyAlphaBranchLog = execFileSync('git', ['log', '--format=%s'], {
    cwd: alphaWorktree,
    encoding: 'utf8',
  });
  check(
    "CLUSTER's completion is unreachable from alpha's own worktree branch history",
    false,
    onlyAlphaBranchLog.includes('chore(infra): cluster'),
  );
  const allBranchesLog = execFileSync('git', ['log', '--all', '--format=%s'], {
    cwd: alphaWorktree,
    encoding: 'utf8',
  });
  check(
    "CLUSTER's completion IS reachable from alpha's worktree via `git log --all`",
    true,
    allBranchesLog.includes('chore(infra): cluster'),
  );

  // alpha's own worktree DB still has CLUSTER as not-complete — no row was
  // ever copied from trunk's completion.
  check(
    "alpha's own worktree DB was never touched by trunk's CLUSTER completion",
    true,
    (() => {
      const db = openGraph(alphaWorktree);
      try {
        return db.prepare("SELECT status FROM tasks WHERE id = 'CLUSTER'").get()?.status !== 'complete';
      } finally {
        db.close();
      }
    })(),
  );

  // The fix: `hedgehog ready`/`status`/`claim`, run INSIDE alpha's own
  // worktree, now report ALPHA-SCHEMA as claimable, credited purely from
  // `git log --all` (crossBranch.mjs) rather than from any row in alpha's
  // own DB.
  const readyInAlpha = cli(alphaWorktree, ['ready']);
  check('ready inside alpha worktree exits 0', 0, readyInAlpha.status);
  checkContains('ready inside alpha worktree reports ALPHA-SCHEMA claimable', readyInAlpha.stdout, 'ALPHA-SCHEMA');

  const statusInAlpha = cli(alphaWorktree, ['status']);
  check('status inside alpha worktree exits 0', 0, statusInAlpha.status);
  checkContains('status inside alpha worktree lists ALPHA-SCHEMA as READY', statusInAlpha.stdout, 'ALPHA-SCHEMA');

  // alpha's own worktree DB also compiled its own local copy of CLUSTER
  // (still `planned` there, since no DB row ever crosses worktrees), which
  // is a genuine, independently-claimable candidate in its own right —
  // and, being `exclusive: true`, it conflicts with (blocks) every other
  // candidate in the same claim batch, ALPHA-SCHEMA included
  // (conflict.mjs#conflicts: either side exclusive is an unconditional
  // conflict). So the fan-out's first call legitimately claims CLUSTER
  // instead, exactly as it would on any project with an exclusive shared
  // layer — this says nothing about the fix under test. Release CLUSTER's
  // claim (this repro never intends to rebuild it a second time inside
  // alpha's worktree) and claim again for the actual assertion.
  const claimedCluster = cli(alphaWorktree, ['claim', '--owner', 'alpha-agent', '--count', '1']);
  check('first claim inside alpha worktree exits 0', 0, claimedCluster.status);
  check(
    "the first claim inside alpha's worktree takes its own local CLUSTER copy, not ALPHA-SCHEMA",
    'building',
    taskStatuses(alphaWorktree)['CLUSTER'],
  );
  const released = cli(alphaWorktree, ['release', 'CLUSTER', '--owner', 'alpha-agent']);
  check('release CLUSTER inside alpha worktree exits 0', 0, released.status);

  const claimedInAlpha = cli(alphaWorktree, ['claim', 'ALPHA-SCHEMA', '--owner', 'alpha-agent']);
  check('claim ALPHA-SCHEMA inside alpha worktree exits 0', 0, claimedInAlpha.status);
  check(
    'ALPHA-SCHEMA was actually claimed (building) inside its own worktree',
    'building',
    taskStatuses(alphaWorktree)['ALPHA-SCHEMA'],
  );
} finally {
  if (alphaWorktree) cleanup(alphaWorktree);
  cleanup(dir);
}

report('a shared/base layer completed on trunk after a dependent intent\'s worktree branched is credited via `git log --all` (#435)');
