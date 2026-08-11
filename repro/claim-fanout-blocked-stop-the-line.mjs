#!/usr/bin/env node
// Repro: a fan-out claim refuses outright, across every module and any
// owner, while any task anywhere in the graph is sitting `blocked` — but
// a targeted claim by task id is exempt, which is how the blocked task
// itself gets reclaimed right after `hedgehog retry` even while the
// fan-out would otherwise still be stopped.
//
// See the stop-the-line comment above claimTasks in claim.mjs: a blocked
// task is the loop's own signal that something needs a human/agent
// decision, and claimTasks refuses to hand out any fresh work anywhere
// until it's retried. claimTask (the targeted variant claimCommand uses
// when given a task id) has no such check, so an operator can still work
// around a block on one specific task while it's open — most
// importantly, reclaim the blocked task itself the moment `hedgehog
// retry` returns it to `planned`.
//
// Asserts:
//   1. fan-out claim succeeds normally with nothing blocked;
//   2. with GAMMA-INFRA blocked (scope_violation, seeded directly via
//      SQL — a failed verification's own end state), a fan-out claim
//      refuses: non-zero exit, names GAMMA-INFRA, and touches nothing
//      else in the graph;
//   3. a targeted claim on a different, claimable task (BETA-INFRA)
//      still succeeds while the block is in place;
//   4. after `hedgehog retry GAMMA-INFRA`, the fan-out claim succeeds
//      again.
//
// The build graph is read through node:sqlite (node --experimental-sqlite),
// never a sqlite3 binary.
//
// Run: node repro/claim-fanout-blocked-stop-the-line.mjs

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { check, checkContains, cleanup, commitAll, finish, hedgehog, makeProject } from './papercuts-lib.mjs';

// Three independent modules under one layer, so ALPHA/BETA/GAMMA never
// conflict with each other on scope or verify radius.
const CORE = `id: demo
layers:
  - id: infra
    scope: ["infra/{module}/**"]
    verify: "true"
    commit: "feat(infra): {module}"
`;

const project = makeProject(CORE);
const dbPath = join(project, '.hedgehog', 'hedgehog.db');

function openGraph() {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}

function taskRow(id) {
  const db = openGraph();
  try {
    return db.prepare('SELECT id, status, blocked_reason, lease_owner FROM tasks WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}

function allTaskRows() {
  const db = openGraph();
  try {
    return db.prepare('SELECT id, status, blocked_reason, lease_owner FROM tasks ORDER BY id').all();
  } finally {
    db.close();
  }
}

try {
  console.log(`repro: claim-fanout-blocked-stop-the-line   (${project})`);

  hedgehog(project, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']);
  hedgehog(project, ['intent', 'add', '--id', 'beta', '--goal', 'g', '--outcome', 'o']);
  hedgehog(project, ['intent', 'add', '--id', 'gamma', '--goal', 'g', '--outcome', 'o']);
  hedgehog(project, ['plan', '--no-open']);
  commitAll(project, 'chore: plan');

  // ── 1. fan-out claim succeeds normally when nothing is blocked ─────
  const first = hedgehog(project, ['claim', '--owner', 'alice', '--count', '1']);
  check('baseline: fan-out claim exits zero with nothing blocked', first.status === 0, {
    expected: 'exit 0',
    actual: `exit ${first.status}`,
  });
  checkContains('baseline: alice is handed ALPHA-INFRA', first.all, 'ALPHA-INFRA');

  const alphaAfterBaseline = taskRow('ALPHA-INFRA');
  check(
    'baseline: ALPHA-INFRA is leased to alice',
    alphaAfterBaseline?.status === 'building' && alphaAfterBaseline?.lease_owner === 'alice',
    { expected: 'building / alice', actual: `${alphaAfterBaseline?.status} / ${alphaAfterBaseline?.lease_owner}` },
  );

  // Release it back to ready so it doesn't confound the rest of the
  // repro — the point already made is that the fan-out worked at all.
  hedgehog(project, ['release', 'ALPHA-INFRA', '--owner', 'alice']);

  // ── seed a block: GAMMA-INFRA failed verification's scope gate ─────
  // Seeded directly via SQL, matching a failed verification's own end
  // state (`blocked` / `scope_violation`), rather than driving an actual
  // scope violation through `hedgehog verify` — the fan-out's
  // stop-the-line check reads only status and blocked_reason, so this is
  // an equivalent and much simpler setup.
  {
    const db = openGraph();
    try {
      db.prepare(
        `UPDATE tasks SET status = 'blocked', blocked_reason = 'scope_violation',
           lease_owner = NULL, lease_expires_at = NULL, leased_at = NULL, claim_snapshot = NULL
         WHERE id = ?`,
      ).run('GAMMA-INFRA');
    } finally {
      db.close();
    }
  }

  const gammaSeeded = taskRow('GAMMA-INFRA');
  check(
    'setup: GAMMA-INFRA is blocked/scope_violation',
    gammaSeeded?.status === 'blocked' && gammaSeeded?.blocked_reason === 'scope_violation',
    { expected: 'blocked / scope_violation', actual: `${gammaSeeded?.status} / ${gammaSeeded?.blocked_reason}` },
  );

  const snapshotBeforeRefusal = allTaskRows();

  // ── 2. fan-out claim refuses the whole batch while GAMMA is blocked ─
  const refused = hedgehog(project, ['claim', '--owner', 'bob', '--count', '1']);
  check('refusal: fan-out claim exits non-zero', refused.status !== 0, {
    expected: 'non-zero exit',
    actual: `exit ${refused.status}`,
  });
  checkContains('refusal: names GAMMA-INFRA as the blocked task', refused.all, 'GAMMA-INFRA');
  checkContains('refusal: says the claim was refused', refused.all, 'Claim refused');

  const snapshotAfterRefusal = allTaskRows();
  check(
    'refusal: nothing in the graph changed status or lease owner',
    JSON.stringify(snapshotAfterRefusal) === JSON.stringify(snapshotBeforeRefusal),
    {
      expected: JSON.stringify(snapshotBeforeRefusal),
      actual: JSON.stringify(snapshotAfterRefusal),
    },
  );

  // ── 3. a targeted claim on a different, claimable task still works ──
  const targeted = hedgehog(project, ['claim', 'BETA-INFRA', '--owner', 'carol']);
  check('targeted: claim on BETA-INFRA exits zero despite the block', targeted.status === 0, {
    expected: 'exit 0',
    actual: `exit ${targeted.status}`,
  });
  checkContains('targeted: carol is handed BETA-INFRA', targeted.all, 'BETA-INFRA');

  const betaAfterTargeted = taskRow('BETA-INFRA');
  check(
    'targeted: BETA-INFRA is leased to carol',
    betaAfterTargeted?.status === 'building' && betaAfterTargeted?.lease_owner === 'carol',
    { expected: 'building / carol', actual: `${betaAfterTargeted?.status} / ${betaAfterTargeted?.lease_owner}` },
  );

  const gammaStillBlocked = taskRow('GAMMA-INFRA');
  check(
    'targeted: GAMMA-INFRA is untouched by the targeted claim',
    gammaStillBlocked?.status === 'blocked' && gammaStillBlocked?.blocked_reason === 'scope_violation',
    { expected: 'blocked / scope_violation', actual: `${gammaStillBlocked?.status} / ${gammaStillBlocked?.blocked_reason}` },
  );

  hedgehog(project, ['release', 'BETA-INFRA', '--owner', 'carol']);

  // ── 4. after retry, the fan-out claim succeeds again ────────────────
  const retried = hedgehog(project, ['retry', 'GAMMA-INFRA']);
  check('retry: exits zero', retried.status === 0, {
    expected: 'exit 0',
    actual: `exit ${retried.status}`,
  });

  const gammaAfterRetry = taskRow('GAMMA-INFRA');
  check(
    'retry: GAMMA-INFRA is back to planned with no block',
    gammaAfterRetry?.status === 'planned' && gammaAfterRetry?.blocked_reason === null,
    { expected: 'planned / null', actual: `${gammaAfterRetry?.status} / ${gammaAfterRetry?.blocked_reason}` },
  );

  const restored = hedgehog(project, ['claim', '--owner', 'dave', '--count', '3']);
  check('restored: fan-out claim exits zero once the block is cleared', restored.status === 0, {
    expected: 'exit 0',
    actual: `exit ${restored.status}`,
  });
  checkContains('restored: dave is handed claimable work', restored.all, 'Claimed');
} finally {
  cleanup(project);
}

finish('claim-fanout-blocked-stop-the-line');
