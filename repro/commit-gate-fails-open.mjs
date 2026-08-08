#!/usr/bin/env node
// Reproduction: the commit gate must fail CLOSED when the lefthook
// binary is unavailable.
//
// The hooks lefthook writes into .git/hooks call the `lefthook` binary.
// If node_modules is cleared — a workspace clean, a fresh clone before
// install, a core switch — the generated hook's lookup chain falls
// through to `echo "Can't find lefthook in PATH"` and the function
// returns 0. The hook exits 0 and the commit lands with no typecheck,
// no lint and no test. Nothing in the output distinguishes that from a
// commit that passed the gate.
//
// This drives the real thing: the real src/golden-cores/full-stack-app/
// lefthook.yml, the real lefthook release pinned by the core's own
// package.json, and a real `git commit`. Nothing is stubbed; the commit
// runs with a PATH cut down to the binaries the generated hook
// legitimately needs (see minimalBin), which is what makes "lefthook is
// unavailable" actually true rather than merely hoped for.
//
// Requires network on first run (it installs lefthook from the
// registry). Everything happens inside its own mkdtemp directory, with
// the git repository one level below it so the harness's own scratch
// files can never be staged; the surrounding repository is never
// touched, and every git invocation is pinned with an explicit cwd and
// an isolated git config.
//
// Exits 0 when the gate refuses the commit, non-zero otherwise.

import { mkdtemp, rm, writeFile, mkdir, readFile, symlink, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'src/golden-cores/full-stack-app');

const failures = [];
function check(label, expected, actual) {
  const ok = expected === actual;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`          expected: ${JSON.stringify(expected)}`);
    console.log(`          actual:   ${JSON.stringify(actual)}`);
    failures.push(label);
  }
}

const run = (cmd, args, opts) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

// A PATH holding only what the generated hook legitimately needs.
//
// Without this the reproduction is not hermetic, and the way it leaks is
// worth knowing: lefthook's generated hook tries `pnpm lefthook -h` as
// one of its fallbacks, and pnpm v11 installs the missing dependency to
// satisfy the exec — so on a developer machine with pnpm and a network,
// a gate with no lefthook can quietly reinstall it mid-commit. That is
// not the behaviour under test, and it is not something to rely on.
async function minimalBin(dir) {
  await mkdir(dir, { recursive: true });
  for (const tool of ['sh', 'git', 'uname', 'sed', 'tr', 'node']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) await symlink(found, join(dir, tool)).catch(() => {});
  }
  return dir;
}

const work = await mkdtemp(join(tmpdir(), 'hedgehog-repro-failsopen-'));
const repo = join(work, 'repo');

// Isolated git: no user hooks, no global core.hooksPath, no signing
// config leaking in from whoever is running this.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

try {
  console.log('repro: commit gate must fail closed when lefthook is missing');
  console.log(`  workspace: ${work}\n`);

  await mkdir(repo, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo, env: gitEnv });
  run('git', ['config', 'user.email', 'repro@example.invalid'], { cwd: repo, env: gitEnv });
  run('git', ['config', 'user.name', 'repro'], { cwd: repo, env: gitEnv });

  // The payload file under test, verbatim.
  await cp(join(CORE, 'lefthook.yml'), join(repo, 'lefthook.yml'));
  // The core's real ignore rules, so what gets staged matches a real project.
  await cp(join(CORE, 'gitignore.template'), join(repo, '.gitignore'));

  // The lefthook version this core actually pins.
  const corePkg = JSON.parse(await readFile(join(CORE, 'package.json'), 'utf8'));
  const lefthookSpec = corePkg.devDependencies?.lefthook;
  if (!lefthookSpec) {
    console.error('  ERROR: full-stack-app package.json no longer pins lefthook.');
    process.exit(1);
  }
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify(
      { name: 'repro', private: true, devDependencies: { lefthook: lefthookSpec } },
      null,
      2,
    ),
  );

  // LEFTHOOK=1 because lefthook's postinstall skips installing hooks
  // when CI is set — without it this would "pass" on CI by never
  // installing a gate in the first place.
  const install = run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'], {
    cwd: repo,
    env: { ...gitEnv, LEFTHOOK: '1' },
  });
  if (install.status !== 0) {
    console.error(
      `  ERROR: could not install lefthook${lefthookSpec} — this reproduction needs the registry.`,
    );
    console.error(install.stderr?.slice(-800) ?? '');
    process.exit(1);
  }
  if (!existsSync(join(repo, '.git/hooks/pre-commit'))) {
    console.error('  ERROR: lefthook did not install a pre-commit hook; nothing to test.');
    process.exit(1);
  }

  // The failure this is about: the tooling is gone, the hooks are not.
  await rm(join(repo, 'node_modules'), { recursive: true, force: true });

  const bin = await minimalBin(join(work, 'bin'));

  await writeFile(join(repo, 'a.ts'), 'export const a: number = 1;\n');
  run('git', ['add', '-A'], { cwd: repo, env: gitEnv });

  const commit = run('git', ['commit', '-m', 'chore: ungated commit'], {
    cwd: repo,
    env: { ...gitEnv, PATH: bin },
  });
  const output = `${commit.stdout ?? ''}${commit.stderr ?? ''}`;

  const log = run('git', ['log', '--oneline'], { cwd: repo, env: gitEnv });
  const commitCount = log.status === 0 ? log.stdout.trim().split('\n').filter(Boolean).length : 0;

  console.log('  --- hook output ---');
  for (const line of output.trim().split('\n')) console.log(`  | ${line}`);
  console.log('  -------------------\n');

  check('git commit is refused (non-zero exit)', true, commit.status !== 0);
  check('no commit was created', 0, commitCount);
  check('the refusal names the --no-verify escape hatch', true, /--no-verify/.test(output));

  if (failures.length) {
    console.log(
      `\nFAILED (${failures.length}): the commit gate fails OPEN — a commit landed with no typecheck, no lint and no test.`,
    );
    process.exit(1);
  }
  console.log('\nOK: the commit gate failed closed.');
} finally {
  if (!process.env.KEEP_REPRO) await rm(work, { recursive: true, force: true });
}
