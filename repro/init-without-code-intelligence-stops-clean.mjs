#!/usr/bin/env node
// Commit 2 of hedgehog-code-intelligence-recommendation.md:
// ensureCodeIntelligence() is the first statement of init(), before any
// write. A machine with no usable Python/CGC and no answerable stdin
// (CI, an agent-driven run, anything piped) must never hang waiting on a
// prompt it can't ask — it takes the accepted-path message directly and
// aborts non-zero, having written nothing at all.
//
// PATH is scrubbed to a single throwaway directory holding nothing, so
// this reproduces regardless of what's actually installed on the host
// running the suite. stdin is left as a real pipe (not a TTY) with no
// data written to it — exactly the "non-interactive, unanswerable"
// shape ensureCodeIntelligence's own comment describes.

import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertIncludes, CLI, runRepro } from './lib.mjs';

// Runs the real CLI with PATH scrubbed to `emptyPathDir` (no python3, no
// python, no cgc/codegraphcontext resolvable), stdin a closed pipe (not a
// TTY, nothing written to it), and a timeout so a regression into a
// blocked prompt fails loudly instead of stalling CI forever.
function hedgehogNoCodeIntelligence(cwd, emptyPathDir, args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      input: '',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: emptyPathDir,
        NODE_NO_WARNINGS: '1',
        NO_COLOR: '1',
        HEDGEHOG_NO_UPDATE_CHECK: '1',
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

await runRepro('code intelligence: init without it stops clean', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hedgehog-repro-'));
  const emptyPathDir = await mkdtemp(join(tmpdir(), 'hedgehog-repro-emptypath-'));
  try {
    const result = hedgehogNoCodeIntelligence(dir, emptyPathDir, ['init']);

    assert(result.code !== 0, `expected non-zero exit, got ${result.code}`);
    assertIncludes(result.out, 'CODE INTELLIGENCE NOT SET UP', 'expected the gap headline');
    assertIncludes(
      result.out,
      'hedgehog-code-intelligence-setup',
      'expected the setup skill to be named',
    );

    // The load-bearing assertion: nothing was written, at all, proving
    // ensureCodeIntelligence runs before any write in init().
    assert(!existsSync(join(dir, '.hedgehog')), 'expected no .hedgehog/ directory to be written');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(emptyPathDir, { recursive: true, force: true });
  }
});
