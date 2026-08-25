#!/usr/bin/env node
// Commit 4 of hedgehog-code-intelligence-recommendation.md: the upgrade
// path for a project that predates the init-time check. `update` calls
// noteCodeIntelligenceGap() only after its own refresh has fully landed,
// and that function never touches process.exitCode — a project whose
// check fails keeps updating exactly as it always did, and hears what's
// missing while it does. The zero exit is the assertion that matters: it's
// what stops a future change from quietly making the advisory notice
// blocking, the same way ensureCodeIntelligence is blocking for `init`.
//
// The project is a real `hedgehog init` run first (check satisfied via
// stub binaries, same technique as init-with-code-intelligence-proceeds),
// so `update` has genuine installed-host/version state to refresh. That
// fixture `init` call prepends the stub dir to the real PATH rather than
// replacing it — the stub python3 must win the walk ahead of whatever
// real interpreter the host has, but `init()` also calls ensureGitRepo(),
// which needs a real `git` on PATH. PATH is then scrubbed to nothing
// before the `update` call under test, so its check fails regardless of
// what's on the host machine running the suite; `update` doesn't shell
// out to git, so nothing else needs the real PATH there.

import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertIncludes, CLI, runRepro } from './lib.mjs';

const PYTHON3_STUB = `#!/bin/sh
echo "3.12"
`;

const CGC_STUB = `#!/bin/sh
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

// Combines stdout and stderr on both success and failure — the gap
// notice this test asserts on prints to stderr (see noteCodeIntelligenceGap
// in bin/cli.mjs), which execFileSync's return value alone would drop on
// a zero exit. spawnSync captures both streams regardless of exit code.
function runCli(cwd, args, env) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    input: '',
    timeout: 15_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', NO_COLOR: '1', HEDGEHOG_NO_UPDATE_CHECK: '1', ...env },
  });

  if (result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT') {
    throw new Error(`hedgehog ${args.join(' ')} did not terminate — it appears to be blocked on a prompt`);
  }

  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

await runRepro('code intelligence: update warns but succeeds without it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hedgehog-repro-'));
  const stubPathDir = await makeStubPath();
  try {
    const cgcPath = await makeCgcStub();

    // Set up a real, checked-satisfied project first via `init` — this is
    // the "existing project" `update` refreshes.
    await mkdir(join(dir, '.hedgehog'), { recursive: true });
    await writeFile(
      join(dir, '.hedgehog/code-intelligence.json'),
      JSON.stringify({ command: cgcPath, args: ['mcp', 'start'] }),
    );

    const initResult = runCli(dir, ['init'], { PATH: `${stubPathDir}:${process.env.PATH}` });
    assert(initResult.code === 0, `expected init to succeed as fixture setup, got ${initResult.code}: ${initResult.out.slice(0, 500)}`);

    // Now update with PATH scrubbed — the check fails, but update must
    // not care.
    const emptyPathDir = await mkdtemp(join(tmpdir(), 'hedgehog-repro-emptypath-'));
    try {
      const result = runCli(dir, ['update'], { PATH: emptyPathDir });

      // The load-bearing assertion: update exits zero despite the failing
      // check — the notice stays advisory rather than becoming blocking.
      assert(result.code === 0, `expected update to exit 0, got ${result.code}: ${result.out.slice(0, 500)}`);
      assertIncludes(result.out, 'Hedgehog agents/skills updated.', 'expected the normal refresh to complete');
      assertIncludes(result.out, 'CODE INTELLIGENCE NOT SET UP', 'expected the advisory gap notice to print');
      assertIncludes(
        result.out,
        'hedgehog-code-intelligence-setup',
        'expected the setup skill to be named in the notice',
      );
    } finally {
      await rm(emptyPathDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(stubPathDir, { recursive: true, force: true });
  }
});
