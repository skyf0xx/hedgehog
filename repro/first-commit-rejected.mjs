#!/usr/bin/env node
// Reproduction: the first commit of a fresh install must succeed
// through the documented path.
//
// `hedgehog init --ts-full-stack-app` prints `git add -A && git commit`
// as a next step, but the pre-commit hook ran `npx nx affected -t
// typecheck --base=HEAD`, and in a repository with no commits `HEAD`
// does not resolve. Every command died with `fatal: ambiguous argument
// 'HEAD': unknown revision`, the commit was rejected, and `git commit
// --no-verify` was the only way through — teaching the project to skip
// its own gate on the one commit that lands the entire codebase.
//
// This drives the real thing: the real src/golden-cores/full-stack-app/
// lefthook.yml, the real pinned lefthook, and a real `git commit` into
// a repository with no history.
//
// `npx` is stubbed, because standing up Nx 23 and the whole workspace
// to exercise a base-ref bug is not viable here. The stub models
// exactly one behaviour of the real thing and no more: nx resolves
// `--base` against git, so the stub rejects a base ref git cannot
// resolve, using git's own message. That is the mechanism under test,
// and it was checked against real lefthook — the unfixed lefthook.yml
// produces the identical `fatal: ambiguous argument 'HEAD'` failure.
//
// The stub also records every invocation, so this asserts the gate
// actually RAN rather than merely that the commit was allowed through:
// a "fix" that skipped the checks on the first commit would fail here.
//
// Requires network on first run (it installs lefthook from the
// registry). Everything happens inside its own mkdtemp directory, with
// the git repository one level below it so the harness's own scratch
// files can never be staged; the surrounding repository is never
// touched.
//
// Exits 0 when the first commit succeeds with the gate running.

import { mkdtemp, rm, writeFile, mkdir, readFile, chmod, symlink, cp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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

// A PATH holding only what the generated hook legitimately needs, plus
// the stub npx written below. Keeping the real npm/pnpm/npx off it is
// what stops the hook reaching the registry mid-commit and makes the
// run deterministic — lefthook itself still resolves, via the absolute
// node_modules path it baked into the hook at install time.
async function minimalBin(dir) {
  await mkdir(dir, { recursive: true });
  for (const tool of ['sh', 'git', 'uname', 'sed', 'tr', 'node']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) await symlink(found, join(dir, tool)).catch(() => {});
  }
  return dir;
}

const work = await mkdtemp(join(tmpdir(), 'hedgehog-repro-firstcommit-'));
const repo = join(work, 'repo');

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

try {
  console.log('repro: the first commit of a fresh install must pass the gate');
  console.log(`  workspace: ${work}\n`);

  await mkdir(repo, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo, env: gitEnv });
  run('git', ['config', 'user.email', 'repro@example.invalid'], { cwd: repo, env: gitEnv });
  run('git', ['config', 'user.name', 'repro'], { cwd: repo, env: gitEnv });

  await cp(join(CORE, 'lefthook.yml'), join(repo, 'lefthook.yml'));
  // The core's real ignore rules, so what gets staged matches a real project.
  await cp(join(CORE, 'gitignore.template'), join(repo, '.gitignore'));

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

  // Stub `npx`: records the call, then mimics the one behaviour of nx
  // this bug is about — resolving `--base` against git. The log lives
  // outside the repo so it is never staged by `git add -A`.
  const bin = await minimalBin(join(work, 'bin'));
  const calls = join(work, 'nx-calls.log');
  await writeFile(
    join(bin, 'npx'),
    [
      '#!/bin/sh',
      `echo "$*" >> ${JSON.stringify(calls)}`,
      'for a in "$@"; do',
      '  case "$a" in',
      '    --base=*)',
      '      b=${a#--base=}',
      '      if ! git rev-parse --verify --quiet "$b^{commit}" >/dev/null 2>&1; then',
      `        echo "fatal: ambiguous argument '$b': unknown revision" >&2`,
      '        exit 128',
      '      fi;;',
      '  esac',
      'done',
      'exit 0',
      '',
    ].join('\n'),
  );
  await chmod(join(bin, 'npx'), 0o755);

  await writeFile(join(repo, 'a.ts'), 'export const a: number = 1;\n');
  run('git', ['add', '-A'], { cwd: repo, env: gitEnv });

  // The documented path, verbatim.
  const commit = run('git', ['commit', '-m', 'chore: install Hedgehog'], {
    cwd: repo,
    env: { ...gitEnv, PATH: bin },
  });
  const output = `${commit.stdout ?? ''}${commit.stderr ?? ''}`;

  const log = run('git', ['log', '--oneline'], { cwd: repo, env: gitEnv });
  const commitCount = log.status === 0 ? log.stdout.trim().split('\n').filter(Boolean).length : 0;

  const invocations = existsSync(calls)
    ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  const nxCalls = invocations.filter((l) => l.startsWith('nx '));

  console.log('  --- hook output ---');
  for (const line of output.trim().split('\n')) console.log(`  | ${line}`);
  console.log('  --- nx invocations ---');
  for (const line of nxCalls) console.log(`  | ${line}`);
  console.log('  ----------------------\n');

  check('the first commit succeeds (zero exit)', true, commit.status === 0);
  check('exactly one commit exists', 1, commitCount);
  check('no unresolvable base ref reached nx', false, /ambiguous argument/.test(output));

  // The gate must still have run. Skipping the checks would make the
  // commit succeed too, and would be the wrong fix.
  for (const target of ['typecheck', 'lint', 'test']) {
    check(
      `the ${target} gate actually ran on the first commit`,
      true,
      nxCalls.some((l) => l.includes(`-t ${target}`)),
    );
  }

  if (failures.length) {
    console.log(`\nFAILED (${failures.length}): the documented first-commit path does not work.`);
    process.exit(1);
  }
  console.log('\nOK: the first commit passed a gate that actually ran.');
} finally {
  if (!process.env.KEEP_REPRO) await rm(work, { recursive: true, force: true });
}
