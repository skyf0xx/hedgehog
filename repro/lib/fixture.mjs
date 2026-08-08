// Shared harness for the `hedgehog boundary` reproductions.
//
// Every repro builds a real Hedgehog project in a throwaway temp dir — a
// git repo, an authored `.hedgehog/core.yaml`, two intents, a compiled
// build graph — and drives it through the real CLI (`bin/cli.mjs`), the
// same binary a consuming project runs. Nothing is stubbed: tasks are
// claimed, files are written, `hedgehog verify` runs the verify command
// and makes the commit.
//
// No test framework and no `sqlite3` binary: assertions are plain
// functions that print expected vs actual and exit non-zero.

import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '../..');
export const CLI = join(REPO_ROOT, 'bin/cli.mjs');

// Two layers, two intents, and a verify command that always passes —
// the repro is about the boundary question, not about whether a layer's
// tests are green. `alpha` is priority 10 and `beta` 20, so `hedgehog
// claim` hands out a deterministic order: ALPHA-MODEL, ALPHA-VIEW,
// BETA-MODEL, BETA-VIEW.
const CORE_YAML = `id: repro
layers:
  - id: model
    scope: [src/{module}/model.txt]
    verify: node -e "process.exit(0)"
    commit: "feat({module}): model"
  - id: view
    depends_on: model
    scope: [src/{module}/view.txt]
    verify: node -e "process.exit(0)"
    commit: "feat({module}): view"
`;

const GITIGNORE = `.hedgehog/hedgehog.db
.hedgehog/hedgehog.db-*
.hedgehog/commit.lock
.hedgehog/graph-server.json
`;

export function runCli(project, args, { env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      signal: err.signal,
    };
  }
}

// execFileSync surfaces stderr only on failure, and the whole point of
// `hedgehog boundary` is that its two streams carry different things —
// so the repros read both on every run, via a shell redirect. The
// capture file lives outside the project: writing it inside would dirty
// the very working tree the command is being asked about.
export function runCliCapturingBoth(project, args, { env = {} } = {}) {
  const errPath = join(mkdtempSync(join(tmpdir(), 'hedgehog-repro-err-')), 'stderr.txt');
  let status = 0;
  let stdout = '';
  try {
    stdout = execSync(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${args
        .map((a) => JSON.stringify(a))
        .join(' ')} 2>${JSON.stringify(errPath)}`,
      { cwd: project, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } },
    );
  } catch (err) {
    status = err.status ?? 1;
    stdout = err.stdout ?? '';
  }
  const stderr = existsSync(errPath) ? readFileSync(errPath, 'utf8') : '';
  rmSync(dirname(errPath), { recursive: true, force: true });
  return { status, stdout, stderr };
}

function git(project, command) {
  return execSync(`git ${command}`, { cwd: project, encoding: 'utf8', stdio: 'pipe' });
}

// A project with the graph compiled, intents committed, and a clean
// working tree — the state a build starts from.
export function makeProject() {
  const project = mkdtempSync(join(tmpdir(), 'hedgehog-boundary-repro-'));

  execSync('git init -q .', { cwd: project, stdio: 'pipe' });
  git(project, 'config user.email repro@example.com');
  git(project, 'config user.name repro');
  git(project, 'config commit.gpgsign false');

  mkdirSync(join(project, '.hedgehog'), { recursive: true });
  writeFileSync(join(project, '.gitignore'), GITIGNORE);
  writeFileSync(join(project, '.hedgehog/core.yaml'), CORE_YAML);
  git(project, 'add -A');
  git(project, 'commit -qm "chore: init"');

  runCli(project, ['db', 'init']);
  runCli(project, ['intent', 'add', '--id', 'alpha', '--goal', 'alpha goal', '--outcome', 'alpha outcome', '--priority', '10']);
  runCli(project, ['intent', 'add', '--id', 'beta', '--goal', 'beta goal', '--outcome', 'beta outcome', '--priority', '20']);

  // `hedgehog plan` also starts the graph server and hands the URL to the
  // OS browser opener; neither is part of what's under test here, and on
  // a headless box the opener may fail after the graph is already
  // written. The effect is asserted below instead of the exit code.
  runCli(project, ['plan']);
  stopGraphServer(project);

  const status = runCli(project, ['status']);
  if (!status.stdout.includes('ALPHA-MODEL')) {
    throw new Error(`fixture: plan did not compile the graph\n${status.stdout}${status.stderr}`);
  }

  // Intents are committed source of truth (`hedgehog db rebuild` replays
  // them); committing them here is also what leaves the tree clean, the
  // state a real build has when a task starts.
  git(project, 'add -A');
  git(project, 'commit -qm "chore: intents"');

  return project;
}

// Claims one task, writes the single file its scope allows, and verifies
// it — one full turn of the loop, through the real CLI. Returns the task
// id that closed.
export function completeNextTask(project, { owner = 'repro' } = {}) {
  const claimed = runCli(project, ['claim', '--owner', owner]);
  const match = claimed.stdout.match(/Task ([A-Z0-9-]+) leased/);
  if (!match) {
    throw new Error(`fixture: nothing claimable\n${claimed.stdout}${claimed.stderr}`);
  }
  const taskId = match[1];
  writeScopeFile(project, taskId);

  const verified = runCli(project, ['verify', taskId, '--owner', owner]);
  if (verified.status !== 0) {
    throw new Error(
      `fixture: verify ${taskId} failed (exit ${verified.status})\n${verified.stdout}${verified.stderr}`,
    );
  }
  return taskId;
}

// Task ids are `<INTENT>-<LAYER>` (plan.mjs), and this fixture's core
// gives every layer exactly one scope path, `src/<module>/<layer>.txt`.
export function writeScopeFile(project, taskId) {
  const [intentId, layerId] = taskId.toLowerCase().split('-');
  const dir = join(project, 'src', intentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${layerId}.txt`), `${taskId}\n`);
}

// `hedgehog plan` leaves a detached graph server running; a repro that
// exits without stopping it leaks a process per run.
export function stopGraphServer(project) {
  const pidfile = join(project, '.hedgehog/graph-server.json');
  if (!existsSync(pidfile)) return;
  try {
    const { pid } = JSON.parse(readFileSync(pidfile, 'utf8'));
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone, or never started — nothing to stop.
  }
}

export function cleanup(project) {
  stopGraphServer(project);
  if (process.env.HEDGEHOG_REPRO_KEEP === '1') {
    console.log(`kept fixture: ${project}`);
    return;
  }
  rmSync(project, { recursive: true, force: true });
}

// ── assertions ──────────────────────────────────────────────────────────
const failures = [];

export function check(label, { expected, actual }) {
  const pass = expected instanceof RegExp ? expected.test(actual) : expected === actual;
  if (pass) {
    console.log(`  ok    ${label}`);
    return true;
  }
  failures.push(label);
  console.log(`  FAIL  ${label}`);
  console.log(`        expected: ${expected instanceof RegExp ? expected.source : JSON.stringify(expected)}`);
  console.log(`        actual:   ${JSON.stringify(actual)}`);
  return false;
}

export function checkExit(label, expected, result) {
  return check(label, { expected, actual: result.status });
}

export function checkNonZeroExit(label, result) {
  if (result.status !== 0) {
    console.log(`  ok    ${label} (exit ${result.status})`);
    return true;
  }
  failures.push(label);
  console.log(`  FAIL  ${label}`);
  console.log('        expected: a non-zero exit code');
  console.log('        actual:   0');
  return false;
}

export function checkContains(label, needle, haystack) {
  if (haystack.includes(needle)) {
    console.log(`  ok    ${label}`);
    return true;
  }
  failures.push(label);
  console.log(`  FAIL  ${label}`);
  console.log(`        expected to contain: ${JSON.stringify(needle)}`);
  console.log(`        actual:              ${JSON.stringify(haystack)}`);
  return false;
}

export function report(name) {
  if (failures.length === 0) {
    console.log(`\n${name}: PASS\n`);
    process.exit(0);
  }
  console.log(`\n${name}: FAIL — ${failures.length} assertion(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  process.exit(1);
}
