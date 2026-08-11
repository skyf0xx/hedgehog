#!/usr/bin/env node
// Repro: a lease that expires on one module must not stop every other
// module's fan-out claim from working at all.
//
// reapExpiredLeases runs lazily, as the first step inside claimTasks's
// transaction — so the first `hedgehog claim` call from *anyone*, working
// *any* module, after a lease lapses is the one that discovers it and
// flips the task to `blocked`/`lease_expired`. claimTasks exempts a block
// it just produced this way from its own stop-the-line refusal, so a dead
// agent on ALPHA doesn't halt BETA's unrelated fan-out claim.
//
// Asserts: agent bob's fan-out claim, which happens to be the call that
// reaps alice's long-dead lease on an unrelated module, still succeeds
// and claims BETA's ready task. The reaped task still ends up
// `blocked`/`lease_expired` and still shows up in `hedgehog status`'s
// NEEDS ATTENTION, and a *subsequent* fan-out claim (with nothing left to
// claim) still refuses, proving the stop-the-line check itself is intact
// for a block that predates the call.
//
// The build graph is read through node:sqlite (node --experimental-sqlite),
// never a sqlite3 binary.
//
// Run: node repro/claim-self-reaped-lease.mjs

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { check, checkContains, cleanup, commitAll, finish, hedgehog, makeProject } from './papercuts-lib.mjs';

// Two independent modules under one layer, so ALPHA and BETA never
// conflict on scope or verify radius and a fan-out claim of one is never
// blocked by the other's being in flight.
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

try {
  console.log(`repro: claim-self-reaped-lease   (${project})`);

  hedgehog(project, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']);
  hedgehog(project, ['intent', 'add', '--id', 'beta', '--goal', 'g', '--outcome', 'o']);
  hedgehog(project, ['plan', '--no-open']);
  commitAll(project, 'chore: plan');
  hedgehog(project, ['claim', '--owner', 'alice', '--count', '1']);

  const claimed = taskRow('ALPHA-INFRA');
  check('setup: ALPHA-INFRA is leased to alice', claimed?.status === 'building' && claimed?.lease_owner === 'alice', {
    expected: 'building / alice',
    actual: `${claimed?.status} / ${claimed?.lease_owner}`,
  });

  // Simulate alice's session dying mid-build: backdate her lease the way
  // wall-clock time would have, with nobody having called `claim` (and
  // so nobody having reaped it) in the interim.
  {
    const db = openGraph();
    try {
      db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?").run('ALPHA-INFRA');
    } finally {
      db.close();
    }
  }

  // bob has never touched ALPHA — he's working BETA. His fan-out claim is
  // the one that happens to reap alice's dead lease as claimTasks's first
  // step. It must still succeed and hand him BETA-INFRA, not refuse
  // outright over a block it just produced itself.
  const bob = hedgehog(project, ['claim', '--owner', 'bob', '--count', '1']);
  check('bob: fan-out claim exits zero despite reaping a dead lease', bob.status === 0, {
    expected: 'exit 0',
    actual: `exit ${bob.status}`,
  });
  checkContains('bob: is handed BETA-INFRA', bob.all, 'BETA-INFRA');

  const beta = taskRow('BETA-INFRA');
  check('bob: BETA-INFRA is leased to bob', beta?.status === 'building' && beta?.lease_owner === 'bob', {
    expected: 'building / bob',
    actual: `${beta?.status} / ${beta?.lease_owner}`,
  });

  // The reap still happened and is still visible.
  const alpha = taskRow('ALPHA-INFRA');
  check(
    'alpha: ALPHA-INFRA still lands in blocked/lease_expired',
    alpha?.status === 'blocked' && alpha?.blocked_reason === 'lease_expired',
    { expected: 'blocked / lease_expired', actual: `${alpha?.status} / ${alpha?.blocked_reason}` },
  );

  const status = hedgehog(project, ['status']);
  checkContains('status: ALPHA-INFRA appears under NEEDS ATTENTION', status.all, 'ALPHA-INFRA');
  checkContains('status: names the lease-expired reason', status.all, 'lease expired');

  // Now that ALPHA-INFRA is sitting there blocked from a *prior* call,
  // the stop-the-line check itself must still be intact: a further
  // fan-out claim refuses, even though there's no more ready work either
  // way (both tasks are now accounted for) — the refusal is what proves
  // it, not the absence of claimable work.
  const carol = hedgehog(project, ['claim', '--owner', 'carol', '--count', '1']);
  check('carol: a later fan-out claim refuses over the pre-existing block', carol.status !== 0, {
    expected: 'non-zero exit',
    actual: `exit ${carol.status}`,
  });
  checkContains('carol: names the blocked task', carol.all, 'ALPHA-INFRA');
} finally {
  cleanup(project);
}

finish('claim-self-reaped-lease');
