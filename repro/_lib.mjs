// Shared plumbing for the reproduction scripts in this directory.
//
// No test framework and no sqlite3 binary on purpose: each repro is a
// standalone Node script that drives the real CLI in a throwaway temp
// directory, asserts with plain checks, prints expected vs actual, and
// exits non-zero on failure. Anything that needs the build graph itself
// reads it through node:sqlite (node --experimental-sqlite), never a
// shell tool.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(REPO_ROOT, 'bin/cli.mjs');

// Distinctive prefix so a stray directory or process is always
// attributable, and so no cleanup ever has to match a broad glob.
const PREFIX = 'hedgehog-papercuts-';

const failures = [];

export function check(label, ok, { expected, actual }) {
  if (ok) {
    console.log(`  ok    ${label}`);
    return true;
  }
  failures.push(label);
  console.log(`  FAIL  ${label}`);
  console.log(`        expected: ${expected}`);
  console.log(`        actual:   ${actual}`);
  return false;
}

export function checkContains(label, haystack, needle) {
  return check(label, haystack.includes(needle), {
    expected: `output containing ${JSON.stringify(needle)}`,
    actual: haystack.trim() === '' ? '(empty output)' : JSON.stringify(haystack.trim().slice(0, 600)),
  });
}

export function finish(name) {
  if (failures.length > 0) {
    console.log(`\n${name}: ${failures.length} check(s) failed\n`);
    process.exit(1);
  }
  console.log(`\n${name}: all checks passed\n`);
  process.exit(0);
}

// A throwaway git repo with a core.yaml and an initialised build graph.
export function makeProject(coreYaml, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  run('git', ['init', '-q'], dir);
  run('git', ['config', 'user.email', 'repro@hedgehog.test'], dir);
  run('git', ['config', 'user.name', 'hedgehog repro'], dir);
  writeFileIn(dir, 'core.yaml', coreYaml);
  hedgehog(dir, ['db', 'init']);
  if (commit) {
    run('git', ['add', 'core.yaml'], dir);
    run('git', ['commit', '-q', '-m', 'chore: core'], dir);
  }
  return dir;
}

export function writeFileIn(dir, name, content) {
  writeFileSync(join(dir, name), content);
}

// Commits everything currently in the tree, so a later `hedgehog verify`
// sees a clean working tree and its scope gate has nothing to complain
// about — otherwise leftover files (the intent JSON `hedgehog intent add`
// writes, for one) trip the scope check before the part under test runs.
export function commitAll(dir, message = 'chore: repro state') {
  run('git', ['add', '-A'], dir);
  run('git', ['commit', '-q', '-m', message], dir);
}

export function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8' });
}

export function hedgehog(cwd, args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env, NO_COLOR: '1' },
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    all: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  };
}

// Graph-server processes this project started, found by the temp dir in
// their argv — never by a bare process-name match, so concurrent work in
// sibling clones is untouched.
export function graphServerPids(projectDir) {
  const ps = run('ps', ['-eo', 'pid=,args='], undefined);
  if (ps.status !== 0 || !ps.stdout) return [];
  return ps.stdout
    .split('\n')
    .filter((line) => line.includes('graph-server.mjs') && line.includes(projectDir))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

// Kills anything this project started, then removes the directory. Safe
// to call twice.
export function cleanup(projectDir) {
  for (const pid of graphServerPids(projectDir)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  rmSync(projectDir, { recursive: true, force: true });
}
