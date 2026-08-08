#!/usr/bin/env node --experimental-sqlite
// REGRESSION GUARD — passes both before and after the fix, on purpose.
//
// The whole point of the scope gate is to catch a task writing outside
// its ALLOWED SCOPE. Narrowing attribution must not narrow that away, so
// this asserts the case that must keep failing: the task's own agent
// writes a file outside scope during the lease, and verify blocks it.
//
// Both flavours are covered — modifying a tracked file out of scope, and
// creating an untracked one — since the fix touches how both are
// attributed.

import { makeRepo, cleanup, seedTask, claimOrThrow, runVerify, write, append, taskRow, check, finish } from './lib.mjs';

const NAME = '01-genuine-violation-still-fails';
console.log(`${NAME}\n`);

// ── a tracked file modified out of scope ──────────────────────────────
{
  const dir = makeRepo();
  try {
    seedTask(dir, { id: 't1', scope: ['pkg-a/**'] });
    claimOrThrow(dir);

    // The agent's own work: in scope, plus one file it had no business in.
    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');
    append(dir, 'docs/notes.md', 'the agent wrote here, out of scope\n');

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check('tracked out-of-scope write: verify exits non-zero', res.code !== 0, true);
    check('tracked out-of-scope write: reports the offending path', res.out.includes('docs/notes.md'), true);
    check('tracked out-of-scope write: task blocked', [row.status, row.blocked_reason], ['blocked', 'scope_violation']);
  } finally {
    cleanup(dir);
  }
}

// ── an untracked file created out of scope ────────────────────────────
{
  const dir = makeRepo();
  try {
    seedTask(dir, { id: 't1', scope: ['pkg-a/**'] });
    claimOrThrow(dir);

    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');
    write(dir, 'pkg-b/src/sneaky.js', 'the agent created this, out of scope\n');

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check('untracked out-of-scope write: verify exits non-zero', res.code !== 0, true);
    check('untracked out-of-scope write: reports the offending path', res.out.includes('pkg-b/src/sneaky.js'), true);
    check('untracked out-of-scope write: task blocked', [row.status, row.blocked_reason], ['blocked', 'scope_violation']);
  } finally {
    cleanup(dir);
  }
}

// ── a file dirty *before* the claim and changed *again* by the agent ───
// The narrowing must not become an amnesty: pre-existing dirt is exempt
// only while the task leaves it alone.
{
  const dir = makeRepo();
  try {
    append(dir, 'docs/notes.md', 'pre-existing dirt\n');
    seedTask(dir, { id: 't1', scope: ['pkg-a/**'] });
    claimOrThrow(dir);

    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');
    append(dir, 'docs/notes.md', 'and then the agent piled on\n');

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check('further-dirtied pre-existing file: verify exits non-zero', res.code !== 0, true);
    check('further-dirtied pre-existing file: reports the offending path', res.out.includes('docs/notes.md'), true);
    check('further-dirtied pre-existing file: task blocked', [row.status, row.blocked_reason], ['blocked', 'scope_violation']);
  } finally {
    cleanup(dir);
  }
}

finish(NAME);
