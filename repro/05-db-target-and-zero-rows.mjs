#!/usr/bin/env node
// The silent-green failure this whole change is aimed at: hand-written
// recovery SQL used a relative database path, ran from the wrong
// directory, opened a different database, matched zero rows, printed
// `undefined`, and exited zero.
//
// Two properties close that off: every command that writes to the build
// graph prints the absolute path of the database it opened, and a
// recovery command that matches no task exits non-zero.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProject, hedgehog, hedgehogAllowFail, assert, assertIncludes, runRepro } from './lib.mjs';

await runRepro('write commands name the database they opened', async () => {
  const { dir, dbPath, cleanup } = await makeProject();
  try {
    for (const args of [
      ['claim', '--owner', 'ag1'],
      ['renew', 'ALPHA-SCHEMA', '--owner', 'ag1'],
      ['release', 'ALPHA-SCHEMA', '--owner', 'ag1'],
      ['friction', 'add', 'a note'],
    ]) {
      const result = hedgehog(dir, args);
      assertIncludes(
        result.out,
        dbPath,
        `\`hedgehog ${args.join(' ')}\` should print the absolute database path it opened`,
      );
    }
  } finally {
    await cleanup();
  }
});

await runRepro('recovery commands fail loudly when they match no task', async () => {
  const { dir, cleanup } = await makeProject();
  try {
    for (const args of [
      ['retry', 'NO-SUCH-TASK'],
      ['claim', 'NO-SUCH-TASK', '--owner', 'ag1'],
      ['release', 'NO-SUCH-TASK', '--owner', 'ag1'],
      ['renew', 'NO-SUCH-TASK', '--owner', 'ag1'],
      ['show', 'NO-SUCH-TASK'],
    ]) {
      const result = hedgehogAllowFail(dir, args);
      assert(result.code !== 0, `\`hedgehog ${args.join(' ')}\` should exit non-zero, got ${result.code}`);
      assertIncludes(result.out, 'No such task', `\`hedgehog ${args.join(' ')}\` should say so`);
    }

    // A task that exists but isn't blocked is a different mistake, and
    // is reported as one rather than silently succeeding.
    const notBlocked = hedgehogAllowFail(dir, ['retry', 'ALPHA-SCHEMA']);
    assert(notBlocked.code !== 0, 'retry on a non-blocked task should exit non-zero');
    assertIncludes(notBlocked.out, 'not blocked', 'retry should say why it refused');
  } finally {
    await cleanup();
  }
});

await runRepro('a recovery command run in the wrong directory refuses', async () => {
  const elsewhere = await mkdtemp(join(tmpdir(), 'hedgehog-repro-empty-'));
  try {
    const result = hedgehogAllowFail(elsewhere, ['retry', 'ALPHA-SCHEMA']);
    assert(result.code !== 0, 'retry with no build graph should exit non-zero');
    assertIncludes(result.out, 'No build graph found', 'it should say there is no graph here');
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
  }
});
