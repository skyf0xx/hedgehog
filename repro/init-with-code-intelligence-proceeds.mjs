#!/usr/bin/env node
// Commit 2 of hedgehog-code-intelligence-recommendation.md:
// ensureCodeIntelligence() must be a real gate, not an unconditional
// wall — a machine that actually satisfies the check (Python 3.10+, CGC
// resolvable, a valid .hedgehog/code-intelligence.json) must sail through
// init with no prompt and no abort at all.
//
// Nothing here talks to real Python or a real CodeGraphContext install:
// a stub `python3` prints the version string checkCodeIntelligence's
// pythonVersion() parses ("3.12"), and a stub executable stands in for
// CGC at the absolute path named by the written config's `command` —
// exactly the shape checkCodeIntelligence's loadConfig()/isExecutable()
// require. The stub directory is prepended to the real PATH rather than
// replacing it: findPython3's PATH walk must resolve this stub first
// regardless of what real python3 the host machine has (this repro must
// pass even where that's older than 3.10), but `init()` also calls
// ensureGitRepo(), which shells out to a real `git` — a fully scrubbed
// PATH would fail that unrelated step instead of exercising the behavior
// under test.

import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertExcludes, assertIncludes, CLI, runRepro } from './lib.mjs';

const PYTHON3_STUB = `#!/bin/sh
# Stands in for a real Python 3.12 interpreter: checkCodeIntelligence's
# pythonVersion() only ever runs \`-c 'import sys; print(...)'\` against
# this binary, so mirroring that one output is the whole contract.
echo "3.12"
`;

const CGC_STUB = `#!/bin/sh
# Stands in for a real CodeGraphContext install. Never actually invoked by
# the init-time check — checkCodeIntelligence only confirms this path is
# executable — but present so an accidental invocation doesn't explode.
exit 0
`;

async function makeStubPath() {
  const stubDir = await mkdtemp(join(tmpdir(), 'hedgehog-repro-stubpath-'));
  const python3Path = join(stubDir, 'python3');
  await writeFile(python3Path, PYTHON3_STUB);
  await chmod(python3Path, 0o755);
  return stubDir;
}

async function makeCgcStub() {
  const cgcDir = await mkdtemp(join(tmpdir(), 'hedgehog-repro-cgc-'));
  const cgcPath = join(cgcDir, 'cgc');
  await writeFile(cgcPath, CGC_STUB);
  await chmod(cgcPath, 0o755);
  return cgcPath;
}

function hedgehogWithCodeIntelligence(cwd, stubPathDir, args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      input: '',
      timeout: 15_000,
      env: {
        ...process.env,
        // Stub dir first so its python3 wins the PATH walk ahead of
        // whatever real interpreter (possibly older than 3.10) the host
        // has; the real PATH stays after it so `git` still resolves.
        PATH: `${stubPathDir}:${process.env.PATH}`,
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

await runRepro('code intelligence: init proceeds when it is set up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hedgehog-repro-'));
  const stubPathDir = await makeStubPath();
  try {
    const cgcPath = await makeCgcStub();

    await mkdir(join(dir, '.hedgehog'), { recursive: true });
    await writeFile(
      join(dir, '.hedgehog/code-intelligence.json'),
      JSON.stringify({ command: cgcPath, args: ['mcp', 'start'] }),
    );

    const result = hedgehogWithCodeIntelligence(dir, stubPathDir, ['init']);

    assert(result.code === 0, `expected exit 0, got ${result.code}: ${result.out.slice(0, 500)}`);
    assertExcludes(result.out, 'CODE INTELLIGENCE NOT SET UP', 'expected no gap notice when the check passes');
    assertExcludes(result.out, 'Set it up now?', 'expected no prompt when the check passes');
    assertIncludes(result.out, 'Hedgehog installed.', 'expected init to complete normally');
    assert(existsSync(join(dir, '.hedgehog/version.json')), 'expected init to actually write the project');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(stubPathDir, { recursive: true, force: true });
  }
});
