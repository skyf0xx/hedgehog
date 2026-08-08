#!/usr/bin/env node --experimental-sqlite
// THE BUG — fails against master, passes after the fix.
//
// A tracked file somewhere else in the repo is already uncommitted when
// the task is claimed: an unfiled friction log, the user's own
// half-finished edit, whatever. The task's agent never touches it. The
// gate reads the whole dirty working tree, so it attributes that file to
// the task and blocks it for work that is not its own.
//
// Two shapes: an ordinary unrelated file, and a tracked shared
// composition seam (a root DI module / package barrel) left dirty by the
// previous session — the file the reported fan-out failure was about,
// here dirtied by someone other than the task being verified.

import { makeRepo, cleanup, seedTask, claimOrThrow, runVerify, append, taskRow, headFiles, headSubject, check, finish } from './lib.mjs';

const NAME = '02-unrelated-dirty-tracked-file';
console.log(`${NAME}\n`);

// ── an unrelated tracked file, dirty before the claim ─────────────────
{
  const dir = makeRepo();
  try {
    // Nobody's task: an uncommitted note sitting in the repo.
    append(dir, 'docs/notes.md', 'friction log entry, filed by a human\n');

    seedTask(dir, { id: 't1', scope: ['pkg-a/**'] });
    claimOrThrow(dir);

    // The agent touches nothing but its own scope.
    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check('unrelated dirty tracked file: verify exits 0', res.code, 0);
    check('unrelated dirty tracked file: task complete', [row.status, row.blocked_reason], ['complete', null]);
    check('unrelated dirty tracked file: commit holds only the task\'s files', headFiles(dir), ['pkg-a/src/index.js']);
    check('unrelated dirty tracked file: commit uses the layer message', headSubject(dir), 'feat(t1): layer');
  } finally {
    cleanup(dir);
  }
}

// ── the shared seam, left dirty before the fan-out started ────────────
// The scheduler hands two tasks out together. The shared composition
// seam they both sit near was already uncommitted when it did so, so
// neither of them changed it — but on master the first one to verify
// wears it.
{
  const dir = makeRepo();
  try {
    append(dir, 'shared.json', '{"seams":1}\n');

    seedTask(dir, { id: 't1', scope: ['pkg-a/**'] });
    seedTask(dir, { id: 't2', scope: ['pkg-b/**'] });

    claimOrThrow(dir, { count: 2 });
    const t1 = taskRow(dir, 't1');
    const t2 = taskRow(dir, 't2');
    check('fan-out: both tasks claimed together', [t1.status, t2.status], ['building', 'building']);

    // Each agent writes only inside its own scope.
    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');
    append(dir, 'pkg-b/src/index.js', 'export const y = 2;\n');

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check('fan-out: t1 verify exits 0', res.code, 0);
    check('fan-out: t1 complete', [row.status, row.blocked_reason], ['complete', null]);
    check("fan-out: t1 commit holds only t1's files", headFiles(dir), ['pkg-a/src/index.js']);

    // And the neighbour still verifies cleanly afterwards.
    const res2 = runVerify(dir, 't2');
    check('fan-out: t2 verify exits 0', res2.code, 0);
    check("fan-out: t2 commit holds only t2's files", headFiles(dir), ['pkg-b/src/index.js']);
  } finally {
    cleanup(dir);
  }
}

finish(NAME);
