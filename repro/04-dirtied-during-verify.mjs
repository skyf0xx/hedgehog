#!/usr/bin/env node --experimental-sqlite
// The harness-writes-during-verify case.
//
// Block 1 is a REGRESSION GUARD (passes before and after): a file
// dirtied only while verify_command is running never reaches gate 1,
// which has already run by then. The original report said this made the
// gate impossible to satisfy; on its own, it does not.
//
// Block 2 is THE BUG (fails against master, passes after the fix), and
// is the reported scenario in full: the harness's telemetry keeps a
// tracked file dirty, the operator commits it to clean the tree, and the
// next verify_command re-dirties it before the *following* verify — so
// the path is dirty again at gate-1 time and there is no ordering that
// wins. Snapshotting at claim time is what breaks that loop: the path
// was already dirty when the task was handed out, so it is not the
// task's.

import { makeRepo, cleanup, seedTask, claimOrThrow, runVerify, append, taskRow, headFiles, check, finish } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = '04-dirtied-during-verify';
console.log(`${NAME}\n`);

// A verify command that writes telemetry out of scope, exactly like a
// PostToolUse hook would, and then succeeds.
const TELEMETRY = 'printf "telemetry\\n" >> docs/notes.md; true';

// ── dirtied only during verify_command ────────────────────────────────
{
  const dir = makeRepo();
  try {
    seedTask(dir, { id: 't1', scope: ['pkg-a/**'], verifyCommand: TELEMETRY });
    claimOrThrow(dir);
    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check('dirtied during verify: verify exits 0', res.code, 0);
    check('dirtied during verify: task complete', [row.status, row.blocked_reason], ['complete', null]);
    check('dirtied during verify: telemetry not committed', headFiles(dir), ['pkg-a/src/index.js']);
    check(
      'dirtied during verify: telemetry really was written',
      readFileSync(join(dir, 'docs/notes.md'), 'utf8').includes('telemetry'),
      true,
    );
  } finally {
    cleanup(dir);
  }
}

// ── dirty at claim time *and* re-dirtied during verify_command ────────
{
  const dir = makeRepo();
  try {
    // The previous run's telemetry, still uncommitted.
    append(dir, 'docs/notes.md', 'telemetry\n');

    seedTask(dir, { id: 't1', scope: ['pkg-a/**'], verifyCommand: TELEMETRY });
    claimOrThrow(dir);
    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');

    const res = runVerify(dir, 't1');
    const row = taskRow(dir, 't1');
    check('re-dirtied telemetry: verify exits 0', res.code, 0);
    check('re-dirtied telemetry: task complete', [row.status, row.blocked_reason], ['complete', null]);
    check('re-dirtied telemetry: not committed', headFiles(dir), ['pkg-a/src/index.js']);
  } finally {
    cleanup(dir);
  }
}

finish(NAME);
