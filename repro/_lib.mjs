// Shared harness for the layer-cardinality reproductions.
//
// Every script here drives the real CLI (`bin/cli.mjs`) inside a throwaway
// temp directory and then reads the resulting build graph straight out of
// `.hedgehog/hedgehog.db` with node:sqlite. No test framework, no
// `sqlite3` binary — plain assertions, a non-zero exit on failure, and
// expected-vs-actual printed for anything that fails.
//
// Run any script with:
//   node --experimental-sqlite repro/<script>.mjs
// (the flag is optional on Node versions where node:sqlite is unflagged).

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(REPO_ROOT, 'bin/cli.mjs');

// Unique to this workstream. Never remove temp dirs by a shared glob —
// sibling clones of this repo are working in the same /tmp.
const TMP_PREFIX = join(tmpdir(), 'hedgehog-cardinality-');

// A module-axis core with cross-cutting work at both ends of the chain:
// `cluster` provisions before any module can start, `deploy` ships after
// every module has landed. Both are the real-world shape the feature
// exists for — one piece of work, not one per module.
export const ONCE_CORE = `
id: cardinality-fixture
layers:
  - id: cluster
    scope: ["infra/cluster/**"]
    verify: "true"
    exclusive: true
    once: true
    commit: "chore(infra): cluster"
  - id: schema
    depends_on: cluster
    scope: ["libs/{module}/schema/**"]
    verify: "true"
    commit: "feat({module}): schema"
  - id: api
    depends_on: schema
    scope: ["apps/api/{module}/**"]
    verify: "true"
    commit: "feat({module}): api"
  - id: deploy
    depends_on: api
    scope: ["infra/deploy/**"]
    verify: "true"
    exclusive: true
    once: true
    commit: "chore(infra): deploy"
`;

export function makeProject(coreYaml, { git = false } = {}) {
  const dir = mkdtempSync(TMP_PREFIX);
  mkdirSync(join(dir, '.hedgehog'), { recursive: true });
  writeFileSync(join(dir, '.hedgehog/core.yaml'), coreYaml);
  if (git) {
    run(dir, 'git', ['init', '-q', '.']);
    run(dir, 'git', ['config', 'user.email', 'repro@example.invalid']);
    run(dir, 'git', ['config', 'user.name', 'repro']);
    run(dir, 'git', ['commit', '-q', '--allow-empty', '-m', 'chore: init']);
  }
  cli(dir, ['db', 'init']);
  return dir;
}

function run(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

// Runs the real CLI. Returns { status, stdout, stderr } rather than
// throwing, so a script can assert on a *failing* command too.
export function cli(cwd, args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err.message),
    };
  }
}

export function addIntent(dir, id, { priority } = {}) {
  const args = ['intent', 'add', '--id', id, '--goal', `build ${id}`, '--outcome', `${id} works`];
  if (priority !== undefined) args.push('--priority', String(priority));
  const r = cli(dir, args);
  if (r.status !== 0) throw new Error(`intent add ${id} failed: ${r.stderr}`);
  return r;
}

export function openGraph(dir) {
  return new DatabaseSync(join(dir, '.hedgehog/hedgehog.db'));
}

// The full compiled graph, canonically ordered — the thing a compile is
// compared against. Timestamps and lease columns are excluded: they are
// wall-clock, not compiler output.
export function dumpGraph(dir) {
  const db = openGraph(dir);
  try {
    return {
      intents: db
        .prepare('SELECT id, goal, outcome, priority, status FROM intents ORDER BY id')
        .all(),
      tasks: db
        .prepare(
          `SELECT id, intent_id, module, layer, objective, scope_globs, verify_command,
                  commit_message, priority, exclusive, verify_radius, status
           FROM tasks ORDER BY id`,
        )
        .all(),
      dependencies: db
        .prepare(
          'SELECT task_id, depends_on_task_id FROM dependencies ORDER BY task_id, depends_on_task_id',
        )
        .all(),
      task_requirements: db
        .prepare(
          'SELECT task_id, requirement_id FROM task_requirements ORDER BY task_id, requirement_id',
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

export function taskIds(dir) {
  const db = openGraph(dir);
  try {
    return db
      .prepare('SELECT id FROM tasks ORDER BY id')
      .all()
      .map((r) => r.id);
  } finally {
    db.close();
  }
}

export function tasksForLayer(dir, layer) {
  const db = openGraph(dir);
  try {
    return db
      .prepare('SELECT id, module, intent_id FROM tasks WHERE layer = ? ORDER BY id')
      .all(layer);
  } finally {
    db.close();
  }
}

export function edgesInto(dir, taskId) {
  const db = openGraph(dir);
  try {
    return db
      .prepare(
        'SELECT depends_on_task_id FROM dependencies WHERE task_id = ? ORDER BY depends_on_task_id',
      )
      .all(taskId)
      .map((r) => r.depends_on_task_id);
  } finally {
    db.close();
  }
}

// `hedgehog plan` starts a detached graph server for the project when it
// compiles anything. Kill it before the temp directory goes away.
export function cleanup(dir) {
  const pidfile = join(dir, '.hedgehog/graph-server.json');
  if (existsSync(pidfile)) {
    try {
      const { pid } = JSON.parse(readFileSync(pidfile, 'utf8'));
      process.kill(pid);
    } catch {
      // Already gone, or never started — nothing to reap.
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

// ── assertions ────────────────────────────────────────────────────────

const failures = [];

export function check(label, expected, actual) {
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  if (e === a) {
    console.log(`  ok    ${label}`);
    return true;
  }
  failures.push({ label, expected: e, actual: a });
  console.log(`  FAIL  ${label}`);
  return false;
}

export function checkContains(label, haystack, needle) {
  if (typeof haystack === 'string' && haystack.includes(needle)) {
    console.log(`  ok    ${label}`);
    return true;
  }
  failures.push({
    label,
    expected: `text containing ${JSON.stringify(needle)}`,
    actual: JSON.stringify(haystack),
  });
  console.log(`  FAIL  ${label}`);
  return false;
}

export function report(title) {
  if (failures.length === 0) {
    console.log(`\nPASS  ${title}\n`);
    return;
  }
  console.log(`\nFAIL  ${title} — ${failures.length} assertion(s)\n`);
  for (const f of failures) {
    console.log(`  ${f.label}`);
    console.log(`    expected: ${f.expected}`);
    console.log(`    actual:   ${f.actual}`);
  }
  console.log('');
  process.exit(1);
}
