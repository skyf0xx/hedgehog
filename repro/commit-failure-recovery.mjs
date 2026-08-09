#!/usr/bin/env node
// Reproduction: when `git commit` fails during verify, the task is
// stranded in `verifying` with no CLI command able to move it.
//
// The commit is the last step of verification and the only one that can
// fail after the task has already left `building` — a git hook that
// rejects the commit (lefthook is the common case), commit signing, an
// unset git identity. The exception escapes past both failure handlers
// (scope_violation and verification_failed), so the state transition
// never runs and the lease is never released.
//
// From `verifying` there is no way back through the CLI:
//   hedgehog release  — only acts on `building`
//   hedgehog verify   — claimForVerify only accepts `building`
//   hedgehog claim    — skips anything already in flight
//   hedgehog renew    — succeeds, and only extends the strand
// The task sits unreachable until the lease expires (45 min by default).
//
// This exercises both commit call sites, because both have the exposure:
//   Case A — a no-op layer (commitNoOpLayer, `git commit --allow-empty`)
//   Case B — an ordinary layer with a real file (commitTouchedPaths)
// and then Case C checks that recovery actually works once the cause is
// removed, which is the whole point of not stranding the task.
//
// The lever is a pre-commit hook exiting non-zero — the cleanest stand-in
// for the lefthook rejection observed in a real run.
//
// Usage:  node repro/commit-failure-recovery.mjs        (--keep retains the temp dir)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'bin', 'cli.mjs');
const KEEP = process.argv.includes('--keep');

// ---------------------------------------------------------------- assertions

const failures = [];

function check(label, { expected, actual, pass }) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`        expected: ${expected}`);
  console.log(`        actual:   ${actual}`);
  if (!pass) failures.push(label);
  return pass;
}

// ------------------------------------------------------------------- helpers

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

// node:sqlite prints an ExperimentalWarning on stderr; it is not part of
// any command's output and would otherwise show up in every assertion.
function stripWarnings(text) {
  return text
    .split('\n')
    .filter((line) => !/ExperimentalWarning|trace-warnings/i.test(line))
    .join('\n')
    .trim();
}

// Never throws: a nonzero exit is an expected outcome here, not a crash.
function hedgehog(cwd, args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: 0, out: stripWarnings(out) };
  } catch (err) {
    return { code: err.status ?? 1, out: stripWarnings(`${err.stdout ?? ''}${err.stderr ?? ''}`) };
  }
}

function taskRow(dbPath, taskId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      db
        .prepare('SELECT status, lease_owner, blocked_reason FROM tasks WHERE id = ?')
        .get(taskId) ?? { status: '(no such task)', lease_owner: null, blocked_reason: null }
    );
  } finally {
    db.close();
  }
}

const describe = (row) => `status=${row.status} lease_owner=${row.lease_owner ?? 'null'}`;

// ------------------------------------------------------------------- fixture

// foundation is the no-op layer (nothing is written into its scope);
// impl is the ordinary one. Both verify with `true` so the only thing
// that can fail is the commit.
const CORE_YAML = `id: repro-core
layers:
  - id: foundation
    scope: [modules/{module}/foundation/**]
    verify: true
    commit: chore(infra): foundation for {module}
  - id: impl
    depends_on: foundation
    scope: [modules/{module}/impl/**]
    verify: true
    commit: feat({module}): impl
`;

const GITIGNORE = `.hedgehog/hedgehog.db
.hedgehog/hedgehog.db-*
.hedgehog/commit.lock
.hedgehog/graph.pid
`;

const HOOK_PATH = ['.git', 'hooks', 'pre-commit'];

// Installs / removes the rejecting pre-commit hook. Note the fixture does
// NOT set core.hooksPath here (unlike no-op-layer-commit.mjs, which
// disables hooks): the hook is the instrument under test.
function installRejectingHook(root) {
  const hook = join(root, ...HOOK_PATH);
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\necho "lefthook: commit-msg rejected" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
}

function removeRejectingHook(root) {
  rmSync(join(root, ...HOOK_PATH), { force: true });
}

function setupProject() {
  const root = mkdtempSync(join(tmpdir(), 'hedgehog-commitfail-'));

  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'repro@example.com']);
  git(root, ['config', 'user.name', 'Hedgehog Repro']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  mkdirSync(join(root, '.hedgehog'), { recursive: true });
  writeFileSync(join(root, '.hedgehog', 'core.yaml'), CORE_YAML);
  writeFileSync(join(root, '.gitignore'), GITIGNORE);
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

// Shared body for both commit call sites: claim the task, make git reject
// the commit, verify, and assert the task did not strand.
function assertSurvivesCommitFailure(root, dbPath, taskId, label) {
  console.log(`${label}\n`);

  const claim = hedgehog(root, ['claim', '--owner', 'repro']);
  if (!claim.out.includes(taskId)) {
    console.error(`could not claim ${taskId}; claim said:\n${claim.out}`);
    process.exit(2);
  }

  installRejectingHook(root);

  const before = taskRow(dbPath, taskId);
  const headBefore = git(root, ['rev-parse', 'HEAD']);
  const verify = hedgehog(root, ['verify', taskId, '--owner', 'repro']);
  const after = taskRow(dbPath, taskId);

  console.log(`  before verify: ${describe(before)}`);
  console.log(`  verify exit ${verify.code}: ${verify.out.split('\n')[0]}`);
  console.log(`  after verify:  ${describe(after)}\n`);

  check(`${taskId}: the commit did not land`, {
    expected: 'HEAD unchanged',
    actual: git(root, ['rev-parse', 'HEAD']) === headBefore ? 'HEAD unchanged' : 'HEAD moved',
    pass: git(root, ['rev-parse', 'HEAD']) === headBefore,
  });

  check(`${taskId}: verify reported failure`, {
    expected: 'nonzero exit',
    actual: `exit ${verify.code}`,
    pass: verify.code !== 0,
  });

  check(`${taskId}: the message says the commit was what failed`, {
    expected: 'output naming the commit as the failure, not just a raw git error',
    actual: verify.out.split('\n')[0] || '(no output)',
    pass: /commit failed/i.test(verify.out),
  });

  check(`${taskId}: the task is NOT stranded in verifying`, {
    expected: 'status other than verifying',
    actual: after.status,
    pass: after.status !== 'verifying',
  });

  check(`${taskId}: the task landed in a state the CLI can act on`, {
    expected: 'building (verify and release both accept it), still leased to repro',
    actual: describe(after),
    pass: after.status === 'building' && after.lease_owner === 'repro',
  });

  // The concrete proof: the two commands a stuck task needs must work.
  const release = hedgehog(root, ['release', taskId, '--owner', 'repro']);
  check(`${taskId}: hedgehog release can recover it`, {
    expected: 'release accepted',
    actual: release.out.split('\n')[0] || '(no output)',
    pass: /Released\./.test(release.out),
  });

  // Put it back in the agent's hands for the recovery case below.
  const reclaim = hedgehog(root, ['claim', '--owner', 'repro']);
  check(`${taskId}: it is claimable again after release`, {
    expected: `${taskId} claimable`,
    actual: reclaim.out.split('\n')[0] || '(no output)',
    pass: reclaim.out.includes(taskId),
  });
}

// ---------------------------------------------------------------------- main

async function main() {
  const root = setupProject();
  const dbPath = join(root, '.hedgehog', 'hedgehog.db');
  console.log(`project: ${root}\n`);

  hedgehog(root, ['db', 'init']);
  hedgehog(root, [
    'intent', 'add',
    '--id', 'demo',
    '--goal', 'survive a rejected commit',
    '--outcome', 'the task stays reachable from the CLI',
  ]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'chore: add demo intent']);
  await planTasksHeadless(root);

  // Case A — the no-op layer: commitNoOpLayer / `git commit --allow-empty`.
  assertSurvivesCommitFailure(
    root, dbPath, 'DEMO-FOUNDATION',
    'Case A — no-op layer, commit rejected by a git hook',
  );

  // Recovery: remove the cause and re-run verify, exactly as the error says.
  console.log('\nCase C1 — recovery of the no-op layer once the hook is gone\n');
  removeRejectingHook(root);
  const recoverA = hedgehog(root, ['verify', 'DEMO-FOUNDATION', '--owner', 'repro']);
  console.log(`  verify exit ${recoverA.code}: ${recoverA.out.split('\n')[0]}\n`);
  check('DEMO-FOUNDATION verifies cleanly after the cause is removed', {
    expected: 'complete',
    actual: taskRow(dbPath, 'DEMO-FOUNDATION').status,
    pass: taskRow(dbPath, 'DEMO-FOUNDATION').status === 'complete',
  });
  check('DEMO-FOUNDATION finally got its commit', {
    expected: 'chore(infra): foundation for demo',
    actual: git(root, ['log', '-1', '--format=%s']),
    pass: git(root, ['log', '-1', '--format=%s']) === 'chore(infra): foundation for demo',
  });

  // Case B — the ordinary layer: commitTouchedPaths. This is the
  // pre-existing call site, the one observed failing under lefthook.
  console.log();
  mkdirSync(join(root, 'modules', 'demo', 'impl'), { recursive: true });
  writeFileSync(join(root, 'modules', 'demo', 'impl', 'thing.txt'), 'real work\n');
  assertSurvivesCommitFailure(
    root, dbPath, 'DEMO-IMPL',
    'Case B — ordinary layer with a real file, commit rejected by a git hook',
  );

  console.log('\nCase C2 — recovery of the ordinary layer once the hook is gone\n');
  removeRejectingHook(root);
  const recoverB = hedgehog(root, ['verify', 'DEMO-IMPL', '--owner', 'repro']);
  console.log(`  verify exit ${recoverB.code}: ${recoverB.out.split('\n')[0]}\n`);
  check('DEMO-IMPL verifies cleanly after the cause is removed', {
    expected: 'complete',
    actual: taskRow(dbPath, 'DEMO-IMPL').status,
    pass: taskRow(dbPath, 'DEMO-IMPL').status === 'complete',
  });
  check('DEMO-IMPL committed exactly its own file', {
    expected: 'feat(demo): impl / modules/demo/impl/thing.txt',
    actual: `${git(root, ['log', '-1', '--format=%s'])} / ${
      git(root, ['show', '--pretty=format:', '--name-only', 'HEAD']) || '(none)'
    }`,
    pass:
      git(root, ['log', '-1', '--format=%s']) === 'feat(demo): impl' &&
      git(root, ['show', '--pretty=format:', '--name-only', 'HEAD']) ===
        'modules/demo/impl/thing.txt',
  });

  // ------------------------------------------------------------------ result
  console.log();
  if (KEEP) console.log(`kept project at ${root}\n`);
  else rmSync(root, { recursive: true, force: true });

  if (failures.length > 0) {
    console.log(`REPRO FAILED — ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    process.exit(1);
  }
  console.log('REPRO PASSED — a rejected commit never strands a task.\n');
}

main().catch((err) => {
  console.error('repro crashed:');
  console.error(err.stack ?? String(err));
  process.exit(2);
});
