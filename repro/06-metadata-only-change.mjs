#!/usr/bin/env node --experimental-sqlite
// THE HOLE IN THE FIRST FIX — fails against the content-only
// fingerprint, passes once the fingerprint covers what git records.
//
// The claim-time snapshot exempts a path whose fingerprint has not moved
// since the claim. Fingerprinting only a file's *bytes* leaves the gate
// steppable: git also records a path's type and its executable bit, so a
// task can make a real, committable change to an out-of-scope path that
// happened to be dirty already — `chmod +x`, a retargeted symlink, a
// file swapped for a symlink to identical content — and the byte hash
// never moves.
//
// Each block below is a genuine out-of-scope change by the task's own
// agent, so each must block. All three verified as passing (exit 0, no
// violation reported, change left sitting in the tree) against the
// content-only fingerprint.

import { chmodSync, symlinkSync, unlinkSync, writeFileSync, statSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, cleanup, seedTask, claimOrThrow, runVerify, append, commitAll, taskRow, check, finish } from './lib.mjs';

const NAME = '06-metadata-only-change';
console.log(`${NAME}\n`);

// ── mode-only change to a pre-dirty out-of-scope file ─────────────────
{
  const dir = makeRepo();
  try {
    // Somebody else's uncommitted edit — the thing the claim snapshot
    // exists to exonerate.
    append(dir, 'docs/notes.md', 'someone else was here\n');

    seedTask(dir, { id: 't1', scope: ['pkg-a/**'] });
    claimOrThrow(dir);

    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');
    // The task's own prohibited change: bytes untouched, mode flipped.
    chmodSync(join(dir, 'docs/notes.md'), 0o755);

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check('mode-only change: verify exits non-zero', res.code !== 0, true);
    check('mode-only change: names the offending path', res.out.includes('docs/notes.md'), true);
    check('mode-only change: task blocked', [row.status, row.blocked_reason], ['blocked', 'scope_violation']);
    check(
      'mode-only change: the exec bit really was set',
      (statSync(join(dir, 'docs/notes.md')).mode & 0o111) !== 0,
      true,
    );
  } finally {
    cleanup(dir);
  }
}

// ── symlink retargeted to a same-content target ───────────────────────
{
  const dir = makeRepo();
  try {
    // Three identical payloads, so following the link can never tell the
    // targets apart — only reading the link itself can.
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(dir, name), 'same\n');
    symlinkSync('a.txt', join(dir, 'seam-link'));
    commitAll(dir, 'chore: links');

    // Pre-existing dirt: someone retargets it before the claim.
    unlinkSync(join(dir, 'seam-link'));
    symlinkSync('b.txt', join(dir, 'seam-link'));

    seedTask(dir, { id: 't1', scope: ['pkg-a/**'] });
    claimOrThrow(dir);

    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');
    // The task's own prohibited change: same payload, different target.
    unlinkSync(join(dir, 'seam-link'));
    symlinkSync('c.txt', join(dir, 'seam-link'));

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check('symlink retarget: verify exits non-zero', res.code !== 0, true);
    check('symlink retarget: names the offending path', res.out.includes('seam-link'), true);
    check('symlink retarget: task blocked', [row.status, row.blocked_reason], ['blocked', 'scope_violation']);
    check('symlink retarget: the retarget really happened', readlinkSync(join(dir, 'seam-link')), 'c.txt');
  } finally {
    cleanup(dir);
  }
}

// ── a file replaced by a symlink to identical content ─────────────────
{
  const dir = makeRepo();
  try {
    // Committed first, so it is not itself an untracked out-of-scope
    // path. Its bytes are exactly what docs/notes.md is about to become,
    // so *following* the link reads back what was already there — only
    // the entry's type distinguishes them.
    writeFileSync(join(dir, 'shadow.txt'), 'baseline\nx\n');
    commitAll(dir, 'chore: shadow');

    // Pre-existing dirt, again by somebody other than the task.
    append(dir, 'docs/notes.md', 'x\n');

    seedTask(dir, { id: 't1', scope: ['pkg-a/**'] });
    claimOrThrow(dir);

    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');
    // The task's own prohibited change: regular file becomes a symlink.
    unlinkSync(join(dir, 'docs/notes.md'));
    symlinkSync('../shadow.txt', join(dir, 'docs/notes.md'));

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check('file to symlink: verify exits non-zero', res.code !== 0, true);
    check('file to symlink: names the offending path', res.out.includes('docs/notes.md'), true);
    check('file to symlink: task blocked', [row.status, row.blocked_reason], ['blocked', 'scope_violation']);
    check(
      'file to symlink: the swap really happened',
      lstatSync(join(dir, 'docs/notes.md')).isSymbolicLink(),
      true,
    );
  } finally {
    cleanup(dir);
  }
}

finish(NAME);
