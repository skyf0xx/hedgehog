#!/usr/bin/env node
// Gap 4: there is no way to claim a specific task, so an `exclusive` task
// starves.
//
// The fan-out walks candidates in (priority, id) order and takes the
// first mutually non-conflicting set. An exclusive task conflicts with
// everything, so any non-exclusive candidate sorting ahead of it takes
// the slot — on every call, forever. This asserts the starvation, that a
// targeted claim breaks it, and that a targeted claim still refuses to
// break the conflict invariant that makes concurrency safe.

import { makeProject, EXCLUSIVE_CORE, hedgehog, hedgehogAllowFail, readTask, assert, assertIncludes, assertExcludes, runRepro } from './lib.mjs';

await runRepro('claim a specific task to break a starvation tie', async () => {
  const { dir, dbPath, cleanup } = await makeProject({
    core: EXCLUSIVE_CORE,
    intents: ['alpha', 'beta'],
  });
  try {
    // The exclusive task is ready and unleased...
    const ready = hedgehog(dir, ['ready']);
    assertIncludes(ready.out, 'ALPHA-ZINTEGRATE', 'the exclusive task should be in the ready set');
    assertIncludes(ready.out, 'exclusive', 'ready should explain why it is held back');

    // ...but the fan-out never hands it out, however large the batch.
    const batch = hedgehog(dir, ['claim', '--owner', 'ag1', '--count', '10']);
    assertIncludes(batch.out, 'ALPHA-SCHEMA', 'the batch claim takes the per-module layers');
    assertIncludes(batch.out, 'BETA-SCHEMA', 'the batch claim takes both modules');
    assert(
      readTask(dbPath, 'ALPHA-ZINTEGRATE').status !== 'building',
      'the exclusive task should have starved — that is the gap being reproduced',
    );

    // A targeted claim does not override the conflict rule: work is in
    // flight that the exclusive task conflicts with, so it refuses, and
    // says what it conflicts with.
    const refused = hedgehogAllowFail(dir, ['claim', 'ALPHA-ZINTEGRATE', '--owner', 'ag2']);
    assert(refused.code !== 0, 'a conflicting targeted claim must exit non-zero');
    assertIncludes(refused.out, 'conflicts with work in flight', 'it should name the conflict');
    assertIncludes(refused.out, 'ALPHA-SCHEMA', 'it should name the in-flight task');

    // Once the batch is handed back, the targeted claim gets the task the
    // fan-out would still never pick.
    hedgehog(dir, ['release', 'ALPHA-SCHEMA', '--owner', 'ag1']);
    hedgehog(dir, ['release', 'BETA-SCHEMA', '--owner', 'ag1']);
    const stillStarved = hedgehog(dir, ['claim', '--owner', 'ag3', '--count', '10']);
    assertExcludes(
      stillStarved.out,
      'TASK  ALPHA-ZINTEGRATE',
      'even with nothing in flight, the fan-out still never picks the exclusive task',
    );
    hedgehog(dir, ['release', 'ALPHA-SCHEMA', '--owner', 'ag3']);
    hedgehog(dir, ['release', 'BETA-SCHEMA', '--owner', 'ag3']);

    const targeted = hedgehog(dir, ['claim', 'ALPHA-ZINTEGRATE', '--owner', 'ag2']);
    assertIncludes(targeted.out, 'Claimed', 'the targeted claim should succeed');
    assertIncludes(targeted.out, 'ALLOWED SCOPE', 'the targeted claim should print the packet');

    const claimed = readTask(dbPath, 'ALPHA-ZINTEGRATE');
    assert(claimed.status === 'building', `expected building, got ${claimed.status}`);
    assert(claimed.lease_owner === 'ag2', `expected lease to ag2, got ${claimed.lease_owner}`);
    assert(claimed.lease_expires_at !== null, 'a building task must carry a lease expiry');

    // The other refusals: already leased, and a dependency not complete.
    const twice = hedgehogAllowFail(dir, ['claim', 'ALPHA-ZINTEGRATE', '--owner', 'ag4']);
    assert(twice.code !== 0, 'claiming an already-leased task must exit non-zero');
    assertIncludes(twice.out, 'Not claimable', 'it should refuse a leased task');

    const missing = hedgehogAllowFail(dir, ['claim', 'NO-SUCH-TASK', '--owner', 'ag2']);
    assert(missing.code !== 0, 'claiming an unknown id must exit non-zero');
    assertIncludes(missing.out, 'No such task', 'it should say the id matched nothing');
  } finally {
    await cleanup();
  }
});

// The dependency refusal needs the default (chained) core.
await runRepro('a targeted claim refuses a task whose dependencies are open', async () => {
  const { dir, cleanup } = await makeProject();
  try {
    const refused = hedgehogAllowFail(dir, ['claim', 'ALPHA-SERVICE', '--owner', 'ag1']);
    assert(refused.code !== 0, 'a targeted claim must not bypass dependency order');
    assertIncludes(refused.out, 'waiting on', 'it should say what the task waits on');
    assertIncludes(refused.out, 'ALPHA-SCHEMA', 'it should name the open dependency');
  } finally {
    await cleanup();
  }
});
