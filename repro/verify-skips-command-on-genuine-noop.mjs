#!/usr/bin/env node
// Reproduction: a genuine no-op layer (nothing in its own scope touched)
// never runs verify_command at all, not just skips the commit — issue
// #440's actual cost complaint was the full verify_command invocation
// (and, upstream of this repo, a full subagent dispatch) for a layer
// foreseeably irrelevant to the intent, not merely the empty commit.
//
// The fixture's verify_command writes a sentinel file as a side effect.
// If verify_command ran, the sentinel exists; if it didn't, it doesn't —
// a more direct signal than exit code or timing.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'bin', 'cli.mjs');

const failures = [];
function check(label, { expected, actual, pass }) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`        expected: ${expected}`);
  console.log(`        actual:   ${actual}`);
  if (!pass) failures.push(label);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function hedgehog(cwd, args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, NO_COLOR: '1', HEDGEHOG_NO_UPDATE_CHECK: '1' },
  });
}

function taskStatus(dbPath, taskId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId)?.status ?? '(missing)';
  } finally {
    db.close();
  }
}

// The sentinel path lives outside every layer's own scope, in a directory
// verify_command alone would create — if it exists afterward, the command
// ran.
const SENTINEL = 'verify-command-ran.marker';

const CORE_YAML = `id: repro-core
layers:
  - id: foundation
    scope: [modules/{module}/foundation/**]
    verify: "touch ${SENTINEL}"
    commit: chore(infra): foundation for {module}
`;

function setupProject() {
  const root = mkdtempSync(join(tmpdir(), 'hedgehog-noop-verify-skip-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'repro@example.com']);
  git(root, ['config', 'user.name', 'Hedgehog Repro']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.hooksPath', '/dev/null']);

  mkdirSync(join(root, '.hedgehog'), { recursive: true });
  writeFileSync(join(root, '.hedgehog', 'core.yaml'), CORE_YAML);
  writeFileSync(join(root, '.gitignore'), `.hedgehog/hedgehog.db\n.hedgehog/hedgehog.db-*\n.hedgehog/commit.lock\n.hedgehog/graph.pid\n${SENTINEL}\n`);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'chore: bootstrap repro project']);
  return root;
}

async function planTasksHeadless(root) {
  const { loadCore } = await import(join(REPO_ROOT, 'src', 'db', 'core.mjs'));
  const { planTasks } = await import(join(REPO_ROOT, 'src', 'db', 'plan.mjs'));
  const { openDb } = await import(join(REPO_ROOT, 'src', 'db', 'init.mjs'));

  const core = await loadCore(join(root, '.hedgehog', 'core.yaml'));
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const db = openDb();
    try {
      return planTasks(db, core);
    } finally {
      db.close();
    }
  } finally {
    process.chdir(cwd);
  }
}

async function main() {
  const root = setupProject();
  const dbPath = join(root, '.hedgehog', 'hedgehog.db');
  console.log(`project: ${root}\n`);

  hedgehog(root, ['db', 'init']);
  hedgehog(root, [
    'intent', 'add',
    '--id', 'demo',
    '--goal', 'exercise the no-op verify_command skip',
    '--outcome', 'the layer closes complete with verify_command never run',
  ]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'chore: add demo intent']);
  await planTasksHeadless(root);

  hedgehog(root, ['claim', '--owner', 'repro']);

  const sentinelPath = join(root, SENTINEL);
  check('sentinel does not exist before verify', {
    expected: 'absent',
    actual: existsSync(sentinelPath) ? 'present' : 'absent',
    pass: !existsSync(sentinelPath),
  });

  hedgehog(root, ['verify', 'DEMO-FOUNDATION', '--owner', 'repro']);

  check('the task closed complete', {
    expected: 'complete',
    actual: taskStatus(dbPath, 'DEMO-FOUNDATION'),
    pass: taskStatus(dbPath, 'DEMO-FOUNDATION') === 'complete',
  });
  check('verify_command never ran (sentinel still absent)', {
    expected: 'absent',
    actual: existsSync(sentinelPath) ? 'present — verify_command ran' : 'absent',
    pass: !existsSync(sentinelPath),
  });

  const noopRecordPath = join(root, '.hedgehog', 'noop', 'demo-foundation.json');
  check('a no-op record was written', {
    expected: `${noopRecordPath} to exist`,
    actual: existsSync(noopRecordPath) ? 'exists' : 'missing',
    pass: existsSync(noopRecordPath),
  });

  console.log();
  rmSync(root, { recursive: true, force: true });

  if (failures.length > 0) {
    console.log(`REPRO FAILED — ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    process.exit(1);
  }
  console.log('REPRO PASSED — a genuine no-op layer skips verify_command entirely.\n');
}

main().catch((err) => {
  console.error('repro crashed:');
  console.error(err.stack ?? String(err));
  process.exit(2);
});
