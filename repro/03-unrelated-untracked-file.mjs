#!/usr/bin/env node --experimental-sqlite
// THE BUG, untracked half — fails against master, passes after the fix.
//
// NOTE ON THE ORIGINAL REPORT. It described tracked and untracked paths
// as asymmetric: a tracked file outside scope blocks, an untracked one is
// "silently ignored". Direct experiment says otherwise — master blocks on
// both, because `changedPaths()` unions `git diff --name-only HEAD` with
// `git ls-files --others --exclude-standard` and gates on the union. What
// actually exonerated the untracked directory in the reported build was a
// different rule: `splitByScope` subtracts every *other in-flight task's*
// declared scope, and the concurrent agent's new directory sat inside its
// own task's scope. The third block below pins that rule, which is
// correct and unchanged.
//
// So this file asserts the consistent behaviour the fix produces: an
// untracked path that was already there when the task was claimed is not
// the task's, exactly like a tracked one — and it is still not committed.

import { makeRepo, cleanup, seedTask, claimOrThrow, runVerify, write, append, taskRow, headFiles, check, finish } from './lib.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const NAME = '03-unrelated-untracked-file';
console.log(`${NAME}\n`);

// ── an untracked file present before the claim ────────────────────────
{
  const dir = makeRepo();
  try {
    write(dir, 'other/new-dir/scratch.txt', 'left behind by someone else\n');

    seedTask(dir, { id: 't1', scope: ['pkg-a/**'] });
    claimOrThrow(dir);

    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check('unrelated untracked file: verify exits 0', res.code, 0);
    check('unrelated untracked file: task complete', [row.status, row.blocked_reason], ['complete', null]);
    check('unrelated untracked file: not committed', headFiles(dir), ['pkg-a/src/index.js']);
    check('unrelated untracked file: still on disk, still untracked', existsSync(join(dir, 'other/new-dir/scratch.txt')), true);
  } finally {
    cleanup(dir);
  }
}

// ── master's actual behaviour, stated as the contrast ─────────────────
// Same file, but created *after* the claim and outside every declared
// scope: nothing distinguishes it from the task's own stray write, so it
// is still attributed. This is the gate doing its job, not a regression.
{
  const dir = makeRepo();
  try {
    seedTask(dir, { id: 't1', scope: ['pkg-a/**'] });
    claimOrThrow(dir);

    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');
    write(dir, 'other/new-dir/scratch.txt', 'appeared during the lease\n');

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check('untracked file appearing during the lease: still blocks', res.code !== 0, true);
    check('untracked file appearing during the lease: blocked reason', [row.status, row.blocked_reason], ['blocked', 'scope_violation']);
  } finally {
    cleanup(dir);
  }
}

// ── a neighbour's untracked file inside the neighbour's own scope ─────
// The rule that actually exonerated the untracked directory in the
// reported build. Correct on master, and must stay correct.
{
  const dir = makeRepo();
  try {
    seedTask(dir, { id: 't1', scope: ['pkg-a/**'] });
    seedTask(dir, { id: 't2', scope: ['pkg-b/**'] });
    claimOrThrow(dir, { count: 2 });

    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');
    write(dir, 'pkg-b/src/brand-new.js', "t2's own new file\n");

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check("neighbour's in-scope untracked file: verify exits 0", res.code, 0);
    check("neighbour's in-scope untracked file: task complete", [row.status, row.blocked_reason], ['complete', null]);
    check("neighbour's in-scope untracked file: not swept into t1's commit", headFiles(dir), ['pkg-a/src/index.js']);
  } finally {
    cleanup(dir);
  }
}

finish(NAME);
