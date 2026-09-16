#!/usr/bin/env node
// Reproduction: `hedgehog fast-path <intent-id> --reason "<why>" --verify
// "<command>"` closes every remaining task of an intent below the normal
// per-layer claim/verify loop — issue #441.
//
// Three things this command must hold, all exercised here:
//   1. The working tree must already be clean (the fix is committed).
//   2. The committed diff since the graph's last credited commit must
//      fall inside the union of the remaining tasks' own scope — a touch
//      outside that union blocks the fast-path exactly like a scope
//      violation blocks `hedgehog verify`.
//   3. `--verify` names a real command that must pass, and the decision
//      survives `hedgehog db rebuild` via a committed record.

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
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, NO_COLOR: '1', HEDGEHOG_NO_UPDATE_CHECK: '1' },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function taskStatuses(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, status FROM tasks').all();
    return Object.fromEntries(rows.map((r) => [r.id, r.status]));
  } finally {
    db.close();
  }
}

// Three layers, one intent, so the fast-path has more than one remaining
// task to close at once.
const CORE_YAML = `id: repro-core
layers:
  - id: foundation
    scope: [modules/{module}/foundation/**]
    verify: "true"
    commit: chore(infra): foundation for {module}
  - id: impl
    depends_on: foundation
    scope: [modules/{module}/impl/**]
    verify: "true"
    commit: feat({module}): impl
  - id: polish
    depends_on: impl
    scope: [modules/{module}/polish/**]
    verify: "true"
    commit: chore({module}): polish
`;

function setupProject() {
  const root = mkdtempSync(join(tmpdir(), 'hedgehog-fastpath-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'repro@example.com']);
  git(root, ['config', 'user.name', 'Hedgehog Repro']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.hooksPath', '/dev/null']);

  mkdirSync(join(root, '.hedgehog'), { recursive: true });
  writeFileSync(join(root, '.hedgehog', 'core.yaml'), CORE_YAML);
  writeFileSync(join(root, '.gitignore'), '.hedgehog/hedgehog.db\n.hedgehog/hedgehog.db-*\n.hedgehog/commit.lock\n.hedgehog/graph.pid\n');
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

  // A prior, ordinarily-verified intent establishes a real
  // newestGraphCommit floor — the honest starting condition for a
  // fast-path check: verify.mjs's own scope gate has the same bootstrap
  // exposure (a project's very first verify has no floor either), so
  // exercising it here as "the second intent in an established project"
  // matches how fast-path is actually meant to be used.
  hedgehog(root, [
    'intent', 'add',
    '--id', 'warmup',
    '--goal', 'establish a real newestGraphCommit floor',
    '--outcome', 'one ordinary task verifies and commits',
  ]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'chore: add warmup intent']);
  await planTasksHeadless(root);
  hedgehog(root, ['claim', '--owner', 'repro']);
  mkdirSync(join(root, 'modules', 'warmup', 'foundation'), { recursive: true });
  writeFileSync(join(root, 'modules', 'warmup', 'foundation', 'thing.txt'), 'warmup\n');
  hedgehog(root, ['verify', 'WARMUP-FOUNDATION', '--owner', 'repro']);
  hedgehog(root, ['claim', '--owner', 'repro']);
  mkdirSync(join(root, 'modules', 'warmup', 'impl'), { recursive: true });
  writeFileSync(join(root, 'modules', 'warmup', 'impl', 'thing.txt'), 'warmup\n');
  hedgehog(root, ['verify', 'WARMUP-IMPL', '--owner', 'repro']);
  hedgehog(root, ['claim', '--owner', 'repro']);
  mkdirSync(join(root, 'modules', 'warmup', 'polish'), { recursive: true });
  writeFileSync(join(root, 'modules', 'warmup', 'polish', 'thing.txt'), 'warmup\n');
  hedgehog(root, ['verify', 'WARMUP-POLISH', '--owner', 'repro']);

  hedgehog(root, [
    'intent', 'add',
    '--id', 'demo',
    '--goal', 'exercise the fast-path command',
    '--outcome', 'a small, already-committed fix closes every remaining task at once',
  ]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'chore: add demo intent']);
  await planTasksHeadless(root);

  // ------------------------------------------------- refusal: dirty tree
  console.log('Refusal — dirty working tree\n');
  mkdirSync(join(root, 'modules', 'demo', 'impl'), { recursive: true });
  writeFileSync(join(root, 'modules', 'demo', 'impl', 'thing.txt'), 'uncommitted\n');
  const dirtyAttempt = hedgehog(root, [
    'fast-path', 'demo', '--reason', 'small fix', '--verify', 'true',
  ]);
  check('fast-path refuses a dirty working tree', {
    expected: 'nonzero exit',
    actual: `exit ${dirtyAttempt.code}`,
    pass: dirtyAttempt.code !== 0,
  });
  git(root, ['checkout', '--', '.']);
  rmSync(join(root, 'modules', 'demo', 'impl', 'thing.txt'), { force: true });

  // ------------------------------------------------- refusal: out-of-scope
  console.log('\nRefusal — commit touches a path outside remaining scope\n');
  mkdirSync(join(root, 'somewhere-else'), { recursive: true });
  writeFileSync(join(root, 'somewhere-else', 'stray.txt'), 'not in any layer scope\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'chore: stray out-of-scope file']);

  const scopeAttempt = hedgehog(root, [
    'fast-path', 'demo', '--reason', 'small fix', '--verify', 'true',
  ]);
  check('fast-path refuses a commit outside remaining scope', {
    expected: 'nonzero exit',
    actual: `exit ${scopeAttempt.code}`,
    pass: scopeAttempt.code !== 0,
  });
  check('the refusal names the offending path', {
    expected: 'somewhere-else/stray.txt mentioned',
    actual: scopeAttempt.out.includes('somewhere-else/stray.txt') ? 'mentioned' : 'not mentioned',
    pass: scopeAttempt.out.includes('somewhere-else/stray.txt'),
  });

  // Undo the stray commit so the next attempt starts from a clean, in-scope state.
  git(root, ['reset', '--hard', 'HEAD~1']);

  // --------------------------------------------------------- happy path
  console.log('\nHappy path — small, already-committed, in-scope fix\n');
  for (const dir of ['foundation', 'impl', 'polish']) {
    mkdirSync(join(root, 'modules', 'demo', dir), { recursive: true });
    writeFileSync(join(root, 'modules', 'demo', dir, 'thing.txt'), `${dir} fix\n`);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fix(demo): one small change across every layer']);

  const fastpath = hedgehog(root, [
    'fast-path', 'demo', '--reason', 'trivial fix already tested', '--verify', 'true',
  ]);
  console.log(`  fast-path exit ${fastpath.code}\n  ${fastpath.out.trim().split('\n').join('\n  ')}\n`);
  check('fast-path succeeds', { expected: 'exit 0', actual: `exit ${fastpath.code}`, pass: fastpath.code === 0 });

  const statuses = taskStatuses(dbPath);
  for (const id of ['DEMO-FOUNDATION', 'DEMO-IMPL', 'DEMO-POLISH']) {
    check(`${id} closed complete`, { expected: 'complete', actual: statuses[id], pass: statuses[id] === 'complete' });
  }

  const recordPath = join(root, '.hedgehog', 'fastpath', 'demo.json');
  check('a committed fast-path record was written', {
    expected: `${recordPath} to exist`,
    actual: existsSync(recordPath) ? 'exists' : 'missing',
    pass: existsSync(recordPath),
  });

  // -------------------------------------------------- survives a rebuild
  console.log('\nRebuild — the fast-path decision must survive it\n');
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  const rebuildOut = hedgehog(root, ['db', 'rebuild']);
  console.log(`  ${rebuildOut.out.trim().split('\n').filter(Boolean).join('\n  ')}\n`);

  const statusesAfterRebuild = taskStatuses(dbPath);
  for (const id of ['DEMO-FOUNDATION', 'DEMO-IMPL', 'DEMO-POLISH']) {
    check(`${id} survives the rebuild as complete`, {
      expected: 'complete',
      actual: statusesAfterRebuild[id],
      pass: statusesAfterRebuild[id] === 'complete',
    });
  }

  console.log();
  rmSync(root, { recursive: true, force: true });

  if (failures.length > 0) {
    console.log(`REPRO FAILED — ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    process.exit(1);
  }
  console.log('REPRO PASSED — fast-path closes remaining tasks, gated by scope and by --verify.\n');
}

main().catch((err) => {
  console.error('repro crashed:');
  console.error(err.stack ?? String(err));
  process.exit(2);
});
