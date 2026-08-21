#!/usr/bin/env node
// `hedgehog-*-loop` instructs logging friction the moment it's hit,
// mid-layer — before the task's own verify runs. `friction add` appends
// to `.hedgehog/friction/log.md`, which then sits dirty in the working
// tree at verify time. That path is build-graph state, committed by
// `friction add` itself, never by a layer — verify's scope gate must not
// attribute it to whatever task happens to be building.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeProject, hedgehog, readTask, assert, assertIncludes, runRepro } from './lib.mjs';

await runRepro('friction logged mid-layer does not block verify', async () => {
  const { dir, dbPath, cleanup } = await makeProject();
  try {
    hedgehog(dir, ['claim', '--owner', 'ag1']);

    await mkdir(join(dir, 'src/alpha'), { recursive: true });
    await writeFile(join(dir, 'src/alpha/schema.txt'), 'schema\n');

    hedgehog(dir, ['friction', 'add', 'hit a snag mid-layer', '--task', 'ALPHA-SCHEMA']);

    const verified = hedgehog(dir, ['verify', 'ALPHA-SCHEMA', '--owner', 'ag1']);
    assertIncludes(verified.out, 'Verified', 'mid-layer friction must not trip the scope gate');

    const task = readTask(dbPath, 'ALPHA-SCHEMA');
    assert(task.status === 'complete', `expected complete, got ${task.status}`);
  } finally {
    await cleanup();
  }
});
