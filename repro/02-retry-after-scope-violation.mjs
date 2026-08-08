#!/usr/bin/env node
// Gap 2: a scope violation blocks the task the same way, with the same
// dead end — blocked_reason is `scope_violation` instead of
// `verification_failed`, and every other command refuses it identically.

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeProject, hedgehog, hedgehogAllowFail, readTask, assert, assertIncludes, runRepro } from './lib.mjs';

await runRepro('retry after a scope violation', async () => {
  const { dir, dbPath, cleanup } = await makeProject();
  try {
    hedgehog(dir, ['claim', '--owner', 'ag1']);

    // In scope, plus one file the task had no business writing.
    await mkdir(join(dir, 'src/alpha'), { recursive: true });
    await writeFile(join(dir, 'src/alpha/schema.txt'), 'schema\n');
    await mkdir(join(dir, 'src/elsewhere'), { recursive: true });
    await writeFile(join(dir, 'src/elsewhere/oops.txt'), 'out of scope\n');

    const violated = hedgehogAllowFail(dir, ['verify', 'ALPHA-SCHEMA', '--owner', 'ag1']);
    assert(violated.code !== 0, 'a scope violation must exit non-zero');
    assertIncludes(violated.out, 'Scope violation', 'verify should name the violation');
    assertIncludes(violated.out, 'src/elsewhere/oops.txt', 'verify should name the offending path');

    const blocked = readTask(dbPath, 'ALPHA-SCHEMA');
    assert(blocked.status === 'blocked', `expected blocked, got ${blocked.status}`);
    assert(
      blocked.blocked_reason === 'scope_violation',
      `expected scope_violation, got ${blocked.blocked_reason}`,
    );

    // Same dead end as a failed verification.
    const reverify = hedgehogAllowFail(dir, ['verify', 'ALPHA-SCHEMA', '--owner', 'ag1']);
    assert(reverify.code !== 0, 'verify still refuses the blocked task');

    // Fix the violation at its source, then retry.
    await rm(join(dir, 'src/elsewhere'), { recursive: true, force: true });
    const retry = hedgehog(dir, ['retry', 'ALPHA-SCHEMA']);
    assertIncludes(retry.out, 'scope violation', 'retry should name what it recovered from');

    const retried = readTask(dbPath, 'ALPHA-SCHEMA');
    assert(retried.status === 'planned', `expected planned after retry, got ${retried.status}`);
    assert(retried.blocked_reason === null, 'retry must clear blocked_reason');
    assert(retried.lease_owner === null, 'a non-building task must hold no lease');

    hedgehog(dir, ['claim', 'ALPHA-SCHEMA', '--owner', 'ag1']);
    const pass = hedgehog(dir, ['verify', 'ALPHA-SCHEMA', '--owner', 'ag1']);
    assertIncludes(pass.out, 'Verified', 'the retried task should verify and commit');
  } finally {
    await cleanup();
  }
});
