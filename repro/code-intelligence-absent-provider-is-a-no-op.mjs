#!/usr/bin/env node
// Piece 1 of hedgehog-code-intelligence-recommendation.md: absent
// .hedgehog/code-intelligence.json must mean the code-intelligence
// columns and the PRE-READ section do not exist at all — the same
// output `hedgehog plan`/`hedgehog next` produced before this feature.
// This is the one reproduction that has to stay green through all three
// pieces of the recommendation.

import { assert, assertExcludes, hedgehog, makeProject, readTask, runRepro } from './lib.mjs';

await runRepro('code intelligence: absent provider is a no-op', async () => {
  // makeProject already compiles 'alpha' through planTasks with no
  // provider — this project never writes .hedgehog/code-intelligence.json,
  // so every route (in-process compile here, CLI `plan` below) takes the
  // no-provider path.
  const { dir, dbPath, cleanup } = await makeProject();
  try {
    const task = readTask(dbPath, 'ALPHA-SCHEMA');
    assert(task, 'expected ALPHA-SCHEMA to exist after compile');
    assert(task.context_symbols === null, `expected context_symbols NULL, got ${task.context_symbols}`);
    assert(task.context_files === null, `expected context_files NULL, got ${task.context_files}`);
    assert(
      task.context_indexed_at === null,
      `expected context_indexed_at NULL, got ${task.context_indexed_at}`,
    );

    const next = hedgehog(dir, ['next']);
    assertExcludes(next.out, 'PRE-READ', 'no PRE-READ section without a provider');

    // Also drive a second intent through the real `hedgehog plan` CLI
    // path (bin/cli.mjs's planCommand), not just the in-process
    // planTasks call makeProject uses — same assertion, the other route.
    hedgehog(dir, ['intent', 'add', '--id', 'beta', '--goal', 'build beta', '--outcome', 'beta works']);
    const planned = hedgehog(dir, ['plan']);
    assertExcludes(planned.out, 'context', 'no per-task context lines without a provider');

    const betaTask = readTask(dbPath, 'BETA-SCHEMA');
    assert(betaTask, 'expected BETA-SCHEMA to exist after plan');
    assert(betaTask.context_symbols === null, `expected context_symbols NULL, got ${betaTask.context_symbols}`);
    assert(betaTask.context_files === null, `expected context_files NULL, got ${betaTask.context_files}`);
    assert(
      betaTask.context_indexed_at === null,
      `expected context_indexed_at NULL, got ${betaTask.context_indexed_at}`,
    );
  } finally {
    await cleanup();
  }
});
