#!/usr/bin/env node
// `hedgehog-*-loop` instructs logging friction the moment it's hit,
// mid-layer — before the task's own verify runs. `friction add` writes
// a record under `.hedgehog/friction/`, which then sits untracked in the
// working tree at verify time. That path is build-graph state, never a
// layer's work — verify's scope gate must not attribute it to whatever
// task happens to be building, and verify must not commit it.

import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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

    const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert(
      !committed.includes('.hedgehog/friction/'),
      `verify must not commit the friction record with the layer's work, got:\n${committed}`,
    );
    const records = (await readdir(join(dir, '.hedgehog/friction'))).filter((n) => n.endsWith('.json'));
    assert(records.length === 1, `expected one friction record on disk, got ${records.length}`);
  } finally {
    await cleanup();
  }
});
