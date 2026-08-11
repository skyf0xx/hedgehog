#!/usr/bin/env node
// Repro: the declared-binary gate spoke for callers it had no business
// speaking for.
//
// The gate runs before verifyTask so a missing binary is never recorded
// as a failed verification. But it originally ran before verifyTask's
// lease/status check too, so a caller who did not hold the task's lease
// — wrong owner, never claimed, lease expired — was told to install a
// binary and retry, when their actual problem was that they cannot
// verify that task at all. The real error only surfaced on the next
// attempt, after they'd gone and installed something.
//
// Asserts, for three callers who cannot verify the task, against a core
// whose layer also has a missing binary:
//   1. wrong owner  — reports the lease, not the binary;
//   2. never claimed — reports the state, not the binary;
//   3. expired lease — reports the reaped lease, not the binary;
// and in every case that no verification was recorded and the verify
// command never ran. Then the control: a caller who *does* hold the
// lease still gets the missing-binary message.
//
// The build graph is read through node:sqlite (node --experimental-sqlite),
// never a sqlite3 binary.
//
// Run: node repro/verify-lease-precedence.mjs

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { check, checkContains, cleanup, commitAll, finish, hedgehog, makeProject } from './papercuts-lib.mjs';

const ABSENT = 'hh-papercut-absent-binary';

// Two intents so one task can be claimed and another left untouched.
const CORE = `id: demo
layers:
  - id: infra
    scope: ["infra/{module}/**"]
    verify: "${ABSENT} validate"
    commit: "feat(infra): {module}"
    requires: ["${ABSENT}"]
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
    return db.prepare('SELECT id, status, lease_owner FROM tasks WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}

function verificationCount(taskId) {
  const db = openGraph();
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM verifications WHERE task_id = ?').get(taskId).n;
  } finally {
    db.close();
  }
}

// The message that must NOT appear when the caller cannot verify.
function assertNotToldToInstall(label, out) {
  check(`${label}: is not told to install a binary`, !out.includes('Not found on PATH'), {
    expected: 'no missing-binary instruction',
    actual: out.trim().slice(0, 500),
  });
}

try {
  console.log(`repro: verify-lease-precedence   (${project})`);

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

  // ── 1. wrong owner ──────────────────────────────────────────────────
  const bob = hedgehog(project, ['verify', 'ALPHA-INFRA', '--owner', 'bob']);
  check('wrong owner: exits non-zero', bob.status !== 0, {
    expected: 'non-zero exit',
    actual: `exit ${bob.status}`,
  });
  checkContains('wrong owner: names the real problem (the lease)', bob.all, 'not leased to bob');
  assertNotToldToInstall('wrong owner', bob.all);

  const afterBob = taskRow('ALPHA-INFRA');
  check("wrong owner: alice's lease is untouched", afterBob?.status === 'building' && afterBob?.lease_owner === 'alice', {
    expected: 'building / alice',
    actual: `${afterBob?.status} / ${afterBob?.lease_owner}`,
  });
  check('wrong owner: no verification recorded', verificationCount('ALPHA-INFRA') === 0, {
    expected: '0 rows in verifications',
    actual: String(verificationCount('ALPHA-INFRA')),
  });

  // ── 2. never claimed ────────────────────────────────────────────────
  const unclaimed = hedgehog(project, ['verify', 'BETA-INFRA', '--owner', 'carol']);
  check('never claimed: exits non-zero', unclaimed.status !== 0, {
    expected: 'non-zero exit',
    actual: `exit ${unclaimed.status}`,
  });
  checkContains('never claimed: names the real problem (the state)', unclaimed.all, 'not leased to carol');
  assertNotToldToInstall('never claimed', unclaimed.all);
  check('never claimed: no verification recorded', verificationCount('BETA-INFRA') === 0, {
    expected: '0 rows in verifications',
    actual: String(verificationCount('BETA-INFRA')),
  });

  // ── 3. expired lease ────────────────────────────────────────────────
  // Backdate alice's lease the way wall-clock time would have.
  {
    const db = openGraph();
    try {
      db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?").run('ALPHA-INFRA');
    } finally {
      db.close();
    }
  }

  const expired = hedgehog(project, ['verify', 'ALPHA-INFRA', '--owner', 'alice']);
  check('expired lease: exits non-zero', expired.status !== 0, {
    expected: 'non-zero exit',
    actual: `exit ${expired.status}`,
  });
  checkContains('expired lease: names the real problem (the lease)', expired.all, 'not leased to alice');
  assertNotToldToInstall('expired lease', expired.all);
  // What the caller is told and what the row ends up saying differ here,
  // and that is verify.mjs's own behaviour, not this gate's:
  // claimForVerify reaps expired leases inside its transaction, reads the
  // freshly-reaped row (hence "currently: blocked" in the message), then
  // throws on the ownership check — and the ROLLBACK in its catch undoes
  // the reap. So the persisted row stays `building`. Asserted as-is
  // rather than as it arguably should be: src/db/verify.mjs is off-limits
  // (a change is open there upstream), and this repro's job is to pin
  // that the gate defers to that error, not to relitigate it.
  const afterExpiry = taskRow('ALPHA-INFRA');
  check('expired lease: the gate itself changed no state', afterExpiry?.status === 'building', {
    expected: 'building — the gate writes nothing; the reap is rolled back by verify.mjs',
    actual: String(afterExpiry?.status),
  });
  checkContains('expired lease: the message reflects the reaped lease', expired.all, 'currently: blocked');
  check('expired lease: no verification recorded', verificationCount('ALPHA-INFRA') === 0, {
    expected: '0 rows in verifications',
    actual: String(verificationCount('ALPHA-INFRA')),
  });

  // ── control: a caller who does hold the lease still gets the gate ───
  // A targeted claim by task id, not `--count` — claim.mjs's stop-the-line
  // check only gates the fan-out, and ALPHA-INFRA sorts ahead of
  // BETA-INFRA, so an untargeted claim could hand back the wrong task.
  hedgehog(project, ['claim', 'BETA-INFRA', '--owner', 'dave']);
  const holder = taskRow('BETA-INFRA');
  check('setup: BETA-INFRA is leased to dave', holder?.status === 'building' && holder?.lease_owner === 'dave', {
    expected: 'building / dave',
    actual: `${holder?.status} / ${holder?.lease_owner}`,
  });

  const dave = hedgehog(project, ['verify', 'BETA-INFRA', '--owner', 'dave']);
  check('lease holder: exits non-zero', dave.status !== 0, {
    expected: 'non-zero exit',
    actual: `exit ${dave.status}`,
  });
  checkContains('lease holder: IS told which binary is missing', dave.all, ABSENT);
  checkContains('lease holder: is told the command did not run', dave.all, 'was not run');
  check('lease holder: task is not blamed — still building', taskRow('BETA-INFRA')?.status === 'building', {
    expected: 'building (lease intact)',
    actual: String(taskRow('BETA-INFRA')?.status),
  });
  check('lease holder: no verification recorded', verificationCount('BETA-INFRA') === 0, {
    expected: '0 rows in verifications',
    actual: String(verificationCount('BETA-INFRA')),
  });
} finally {
  cleanup(project);
}

finish('verify-lease-precedence');
