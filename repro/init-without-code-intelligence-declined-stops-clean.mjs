#!/usr/bin/env node
// Commit 2 of hedgehog-code-intelligence-recommendation.md:
// ensureCodeIntelligence()'s interactive branch — offered the "Set it up
// now?" question and answering no — must also abort non-zero having
// written nothing, and must say that re-running `init` continues from
// there rather than requiring anything more elaborate.
//
// HEDGEHOG_FORCE_INTERACTIVE forces the prompt on without a real pty
// (piped stdin included), which is exactly what lets this repro drive
// the interactive branch headlessly. PATH is scrubbed the same way as
// the non-interactive repro so the check fails regardless of what's on
// the host machine running the suite.

import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertIncludes, CLI, runRepro } from './lib.mjs';

// Runs the real CLI with PATH scrubbed, HEDGEHOG_FORCE_INTERACTIVE=1 so
// ensureCodeIntelligence's confirm() prompt fires over a plain pipe, and
// 'n\n' fed on stdin to decline it. Timeout guards against a regression
// where the prompt never resolves.
function hedgehogDecline(cwd, emptyPathDir, args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      input: 'n\n',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: emptyPathDir,
        NODE_NO_WARNINGS: '1',
        NO_COLOR: '1',
        HEDGEHOG_NO_UPDATE_CHECK: '1',
        HEDGEHOG_FORCE_INTERACTIVE: '1',
      },
    });
    return { code: 0, out };
  } catch (err) {
    if (err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
      throw new Error('hedgehog init did not terminate — it appears to be blocked on a prompt');
    }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

await runRepro('code intelligence: init declined stops clean', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hedgehog-repro-'));
  const emptyPathDir = await mkdtemp(join(tmpdir(), 'hedgehog-repro-emptypath-'));
  try {
    const result = hedgehogDecline(dir, emptyPathDir, ['init']);

    assert(result.code !== 0, `expected non-zero exit, got ${result.code}`);
    assertIncludes(result.out, 'CODE INTELLIGENCE NOT SET UP', 'expected the gap headline (the offer)');
    assertIncludes(
      result.out,
      'hedgehog-code-intelligence-setup',
      'expected the setup skill to be named',
    );
    assertIncludes(result.out, 'Set it up now?', 'expected the interactive confirm prompt to have fired');
    assertIncludes(
      result.out,
      'the install continues from there',
      'expected the declined message to say re-running init continues from there',
    );

    // The load-bearing assertion: nothing was written, at all.
    assert(!existsSync(join(dir, '.hedgehog')), 'expected no .hedgehog/ directory to be written');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(emptyPathDir, { recursive: true, force: true });
  }
});
