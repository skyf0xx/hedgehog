#!/usr/bin/env node
// Piece 1 of hedgehog-code-intelligence-recommendation.md: a provider
// that resolves context must land its JSON in context_symbols/
// context_files/context_indexed_at at compile time, and next.mjs's
// formatPacket must render a PRE-READ section from context_files. No CGC
// process anywhere — the stub is a plain object exposing a synchronous
// resolveTaskContext(task), the exact surface planTasks(db, core,
// overrides, { provider }) documents. Driven through planTasks directly
// (the CLI only ever builds a provider from a config file), then read
// back through the real `hedgehog show` — BETA-SCHEMA isn't the ready
// task (ALPHA-SCHEMA, compiled with no provider by makeProject, is), so
// `show` is used to reach its packet regardless of queue position.

import { join } from 'node:path';
import { assert, assertIncludes, hedgehog, makeProject, readTask, runRepro } from './lib.mjs';

await runRepro('code intelligence: fake provider populates columns and renders PRE-READ', async () => {
  // makeProject already compiles 'alpha' through planTasks with no
  // provider. This test adds a second intent, 'beta', and compiles it
  // in-process with a stub provider attached, so BETA-SCHEMA is the row
  // under test.
  const { dir, dbPath, cleanup } = await makeProject();
  const stubSymbols = [{ name: 'widget', kind: 'function', path: 'src/beta/widget.mjs', start_line: 12 }];
  const stubFiles = ['src/beta/widget.mjs', 'src/beta/helper.mjs'];
  try {
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const { openDb } = await import('../src/db/init.mjs');
      const { addIntent } = await import('../src/db/intent.mjs');
      const { planTasks } = await import('../src/db/plan.mjs');
      const { loadCore } = await import('../src/db/core.mjs');

      const provider = {
        resolveTaskContext: (task) => {
          if (task.id !== 'BETA-SCHEMA') return null;
          return { symbols: stubSymbols, files: stubFiles };
        },
      };

      const db = openDb();
      try {
        await addIntent(db, {
          id: 'beta',
          goal: 'build beta',
          outcome: 'beta works',
          rules: ['beta must be correct'],
        });
        planTasks(db, await loadCore(join(dir, '.hedgehog/core.yaml')), new Map(), { provider });
      } finally {
        db.close();
      }
    } finally {
      process.chdir(previousCwd);
    }

    const task = readTask(dbPath, 'BETA-SCHEMA');
    assert(task, 'expected BETA-SCHEMA to exist after compile');
    assert(
      JSON.parse(task.context_symbols)[0].name === 'widget',
      `expected context_symbols to carry the stub symbol, got ${task.context_symbols}`,
    );
    assert(
      JSON.stringify(JSON.parse(task.context_files)) === JSON.stringify(stubFiles),
      `expected context_files to carry the stub files, got ${task.context_files}`,
    );
    assert(
      typeof task.context_indexed_at === 'string' && task.context_indexed_at.length > 0,
      `expected context_indexed_at to be an ISO timestamp, got ${task.context_indexed_at}`,
    );

    const shown = hedgehog(dir, ['show', 'BETA-SCHEMA']);
    assertIncludes(shown.out, 'PRE-READ', 'expected a PRE-READ section when context_files is populated');
    assertIncludes(shown.out, 'src/beta/widget.mjs', 'expected PRE-READ to name the resolved file');
    assertIncludes(shown.out, 'src/beta/helper.mjs', 'expected PRE-READ to name the resolved file');
  } finally {
    await cleanup();
  }
});
