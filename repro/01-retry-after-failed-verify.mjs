#!/usr/bin/env node
// Gap 1: a failed verification leaves the task `blocked` with no way back.
//
// The documented recovery ("fix it and re-run hedgehog verify <task-id>")
// cannot work: verify's Phase 0 asserts `status === 'building' &&
// lease_owner === owner`, and blocking a task clears both. `release` only
// accepts `building`. So before `hedgehog retry`, the only exit from
// `blocked` is an UPDATE against the database by hand.

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeProject, hedgehog, hedgehogAllowFail, readTask, assert, assertIncludes, runRepro } from './lib.mjs';

await runRepro('retry after a failed verify', async () => {
  const { dir, dbPath, cleanup } = await makeProject();
  try {
    // Claim the one ready task and do its work.
    const claim = hedgehog(dir, ['claim', '--owner', 'ag1']);
    assertIncludes(claim.out, 'ALPHA-SCHEMA', 'claim should hand out the first layer');
    await mkdir(join(dir, 'src/alpha'), { recursive: true });
    await writeFile(join(dir, 'src/alpha/schema.txt'), 'schema\n');

    // Make the layer's verify command fail, and gate it.
    await writeFile(join(dir, 'FAIL'), '');
    const failed = hedgehogAllowFail(dir, ['verify', 'ALPHA-SCHEMA', '--owner', 'ag1']);
    assert(failed.code !== 0, 'a failing verify command must exit non-zero');
    assertIncludes(failed.out, 'Verification failed', 'verify should report the failure');

    const blocked = readTask(dbPath, 'ALPHA-SCHEMA');
    assert(blocked.status === 'blocked', `expected blocked, got ${blocked.status}`);
    assert(
      blocked.blocked_reason === 'verification_failed',
      `expected verification_failed, got ${blocked.blocked_reason}`,
    );

    // The documented path is a dead end: verify refuses a task it does
    // not hold a lease on, and release refuses anything not `building`.
    await rm(join(dir, 'FAIL'));
    const reverify = hedgehogAllowFail(dir, ['verify', 'ALPHA-SCHEMA', '--owner', 'ag1']);
    assert(reverify.code !== 0, 're-running verify on a blocked task should still fail');
    assertIncludes(reverify.out, 'not leased', 'verify refuses a blocked task for lack of a lease');
    const rerelease = hedgehogAllowFail(dir, ['release', 'ALPHA-SCHEMA', '--owner', 'ag1']);
    assert(rerelease.code !== 0, 'release should refuse a blocked task');

    // The new command: back to planned, lease invariant intact.
    const retry = hedgehog(dir, ['retry', 'ALPHA-SCHEMA']);
    assertIncludes(retry.out, 'Retried', 'retry should report the transition');
    const retried = readTask(dbPath, 'ALPHA-SCHEMA');
    assert(retried.status === 'planned', `expected planned after retry, got ${retried.status}`);
    assert(retried.blocked_reason === null, 'retry must clear blocked_reason');
    assert(retried.lease_owner === null, 'a non-building task must hold no lease');

    // And the loop closes: claim it again, verify it, done.
    hedgehog(dir, ['claim', 'ALPHA-SCHEMA', '--owner', 'ag1']);
    const pass = hedgehog(dir, ['verify', 'ALPHA-SCHEMA', '--owner', 'ag1']);
    assertIncludes(pass.out, 'Verified', 'the retried task should verify and commit');
    assert(
      readTask(dbPath, 'ALPHA-SCHEMA').status === 'complete',
      'the retried task should end up complete',
    );
  } finally {
    await cleanup();
  }
});
