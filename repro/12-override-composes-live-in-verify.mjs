#!/usr/bin/env node --experimental-sqlite
// REGRESSION GUARD for issue #432 — a scope override written after claim
// but before `hedgehog plan --recompile` must still widen scope for the
// verify that follows, not just for a later recompile.
//
// Sequence under test: claim a task -> write an override file (via the
// real `hedgehog override add`, deliberately never followed by `plan
// --recompile`) -> touch a file that's in scope only through the
// override's scope_add -> verify. Before the fix, verify read
// task.scope_globs straight off the DB row (never widened, since only
// `plan --recompile` writes that column) and flagged the override-only
// file as a scope violation. After the fix, verify composes the override
// live, so the file lands in the commit instead.
//
// The task id is upper-case (T1) to match plan.mjs#taskId/#onceTaskId's
// real convention — composeScope's Map lookup is exact-match against
// whatever case validateOverride normalized "task" to (always
// upper-case), so a lower-case id here would silently no-op the override
// and this repro would "pass" for the wrong reason.

import { makeRepo, cleanup, seedTask, claimOrThrow, runVerify, append, taskRow, headFiles, check, finish, CLI } from './scope-gate-lib.mjs';
import { execFileSync } from 'node:child_process';

const NAME = '12-override-composes-live-in-verify';
console.log(`${NAME}\n`);

function runOverrideAdd(dir, taskId, glob, reason) {
  return execFileSync(
    process.execPath,
    ['--experimental-sqlite', CLI, 'override', 'add', taskId, '--scope', glob, '--reason', reason],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', HEDGEHOG_NO_UPDATE_CHECK: '1' } },
  );
}

{
  const dir = makeRepo();
  try {
    seedTask(dir, { id: 'T1', scope: ['pkg-a/**'] });
    claimOrThrow(dir);

    // Widens T1's scope to also cover docs/, but deliberately never
    // followed by `hedgehog plan --recompile` — the exact gap issue #432
    // describes.
    runOverrideAdd(dir, 'T1', 'docs/**', 'composition seam: shared release notes');

    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');
    append(dir, 'docs/notes.md', 'touched only via the override, no recompile run\n');

    const res = runVerify(dir, 'T1');
    const row = taskRow(dir, 'T1');
    check('override-only file: verify exits zero', res.code === 0, true);
    check('override-only file: task completes', row.status, 'complete');
    check(
      'override-only file: lands in the commit',
      headFiles(dir).includes('docs/notes.md'),
      true,
    );
  } finally {
    cleanup(dir);
  }
}

// ── a file outside both core scope and the override's scope_add is still
// a genuine violation — the fix must not turn overrides into a blanket
// amnesty for the task's other out-of-scope writes.
{
  const dir = makeRepo();
  try {
    seedTask(dir, { id: 'T1', scope: ['pkg-a/**'] });
    claimOrThrow(dir);

    runOverrideAdd(dir, 'T1', 'docs/**', 'composition seam: shared release notes');

    append(dir, 'pkg-a/src/index.js', 'export const x = 2;\n');
    append(dir, 'pkg-b/src/index.js', 'export const b = 2;\n');

    const res = runVerify(dir, 'T1');
    const row = taskRow(dir, 'T1');
    check('still-out-of-scope write: verify exits non-zero', res.code !== 0, true);
    check('still-out-of-scope write: reports the offending path', res.out.includes('pkg-b/src/index.js'), true);
    check('still-out-of-scope write: task blocked', [row.status, row.blocked_reason], ['blocked', 'scope_violation']);
  } finally {
    cleanup(dir);
  }
}

finish(NAME);
