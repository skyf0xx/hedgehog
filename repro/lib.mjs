// Shared fixture harness for the repro scripts in this directory.
//
// Each repro builds a throwaway git repo in a temp dir, gives it a
// two-layer authored core, and drives the REAL CLI (bin/cli.mjs) against
// it as a subprocess — no test framework, no `sqlite3` binary, nothing
// mocked. Assertions are plain: on failure the script prints expected vs
// actual and exits non-zero.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const CLI = join(REPO_ROOT, 'bin/cli.mjs');

// The fixture core: two layers in a chain, both with a verify command
// that trivially passes, so the repro exercises the packet/verify
// plumbing rather than a real toolchain.
const CORE_YAML = `id: reprocore
layers:
  - id: domain-model
    scope: ["src/{module}/model/**"]
    verify: node --version
    commit: "feat({module}): domain model"
  - id: domain-service
    depends_on: domain-model
    scope: ["src/{module}/service/**"]
    verify: node --version
    commit: "feat({module}): domain service"
`;

// The goal/outcome under test — deliberately the shape from the report:
// a goal naming three operations, of which a layer could build two.
export const GOAL =
  'allow creating, editing and moving Cards between Lists';
export const OUTCOME =
  'a Card can be created, its scalar fields updated, and moved between Lists';

export function makeFixture({ goal = GOAL, outcome = OUTCOME } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hedgehog-repro-'));
  const run = (args, opts = {}) =>
    execFileSync('node', [CLI, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      ...opts,
    });

  mkdirSync(join(dir, '.hedgehog'), { recursive: true });
  writeFileSync(join(dir, '.hedgehog/core.yaml'), CORE_YAML);
  writeFileSync(join(dir, '.gitignore'), '.hedgehog/hedgehog.db*\n.hedgehog/commit.lock\n.hedgehog/graph-server.json\n');

  const git = (cmd) => execFileSync('git', cmd, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git(['init', '-q', '.']);
  git(['config', 'user.email', 'repro@example.com']);
  git(['config', 'user.name', 'repro']);
  git(['add', '-A']);
  git(['commit', '-qm', 'chore: fixture']);

  run(['db', 'init']);
  run([
    'intent', 'add',
    '--id', 'card',
    '--goal', goal,
    '--outcome', outcome,
    '--rule', 'moving a Card between Lists restarts the time-in-list clock',
  ]);
  run(['plan']);

  // `intent add` writes .hedgehog/intents/<id>.json into the working
  // tree; left uncommitted it sits outside every task's scope and trips
  // verify's scope gate before any of this repro's own assertions run.
  git(['add', '-A']);
  git(['commit', '-qm', 'chore: intents']);

  const cleanup = () => {
    // `hedgehog plan` detaches a graph server; kill it so the temp dir
    // can go away and the repro process can exit.
    try {
      const { pid } = JSON.parse(readFileSync(join(dir, '.hedgehog/graph-server.json'), 'utf8'));
      process.kill(pid);
    } catch {
      // No server running, or already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  };

  return { dir, run, git, cleanup };
}

// Writes a file inside a task's allowed scope so `hedgehog verify` has
// something in-scope to commit.
export function writeInScope(dir, relPath, contents) {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

const failures = [];

export function assertIncludes(haystack, needle, what) {
  if (haystack.includes(needle)) {
    console.log(`  ok    ${what}`);
    return;
  }
  failures.push({ what, expected: needle, actual: haystack });
  console.log(`  FAIL  ${what}`);
}

export function report(title) {
  if (failures.length === 0) {
    console.log(`\n${title}: PASS\n`);
    return;
  }
  console.error(`\n${title}: FAIL — ${failures.length} assertion(s)\n`);
  for (const f of failures) {
    console.error(`  ✗ ${f.what}`);
    console.error(`    expected output to contain:\n      ${JSON.stringify(f.expected)}`);
    console.error(`    actual output was:\n${f.actual.split('\n').map((l) => `      | ${l}`).join('\n')}\n`);
  }
  process.exit(1);
}
