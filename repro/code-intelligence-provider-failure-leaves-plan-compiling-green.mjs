#!/usr/bin/env node
// Piece 1 of hedgehog-code-intelligence-recommendation.md: plan.mjs's
// contextColumns wraps provider.resolveTaskContext(task) in a try/catch
// and returns [null, null, null] on any throw, rather than letting the
// exception escape into the BEGIN IMMEDIATE transaction — a slow or
// broken index must never cost someone their plan run. Drives a stub
// whose resolveTaskContext always throws, through planTasks directly,
// and confirms every task still compiles with NULL context.

import { join } from 'node:path';
import { assert, makeProject, readTask, runRepro } from './lib.mjs';

await runRepro('code intelligence: provider failure leaves the plan compiling green', async () => {
  // makeProject already compiles 'alpha' through planTasks with no
  // provider. This test adds a second intent, 'beta', and compiles it
  // in-process with a provider that always throws, so BETA-SCHEMA and
  // BETA-SERVICE are the rows under test.
  const { dir, dbPath, cleanup } = await makeProject();
  try {
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const { openDb } = await import('../src/db/init.mjs');
      const { addIntent } = await import('../src/db/intent.mjs');
      const { planTasks } = await import('../src/db/plan.mjs');
      const { loadCore } = await import('../src/db/core.mjs');

      const throwingProvider = {
        resolveTaskContext: () => {
          throw new Error('index unreachable');
        },
      };

      const db = openDb();
      let result;
      try {
        await addIntent(db, {
          id: 'beta',
          goal: 'build beta',
          outcome: 'beta works',
          rules: ['beta must be correct'],
        });
        result = planTasks(db, await loadCore(join(dir, '.hedgehog/core.yaml')), new Map(), {
          provider: throwingProvider,
        });
      } finally {
        db.close();
      }

      assert(
        result.compiled.includes('beta'),
        `expected 'beta' to compile despite the provider throwing, got compiled=${JSON.stringify(result.compiled)}`,
      );
    } finally {
      process.chdir(previousCwd);
    }

    // Both layers of the two-layer DEFAULT_CORE chain must have compiled
    // — a rolled-back transaction would leave neither row behind.
    for (const taskId of ['BETA-SCHEMA', 'BETA-SERVICE']) {
      const task = readTask(dbPath, taskId);
      assert(task, `expected ${taskId} to exist — provider failure must not roll back the plan`);
      assert(task.context_symbols === null, `expected context_symbols NULL on ${taskId}, got ${task.context_symbols}`);
      assert(task.context_files === null, `expected context_files NULL on ${taskId}, got ${task.context_files}`);
      assert(
        task.context_indexed_at === null,
        `expected context_indexed_at NULL on ${taskId}, got ${task.context_indexed_at}`,
      );
    }
  } finally {
    await cleanup();
  }
});
