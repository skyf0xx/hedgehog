#!/usr/bin/env node
// Reproduction: a layer that verifies with nothing touched closes
// `complete` without writing a commit.
//
// Why it matters: `.hedgehog/hedgehog.db` is gitignored and documented as
// derived state, rebuildable by replaying the committed sources against
// git history (`hedgehog db rebuild`). A task that reached `complete`
// while HEAD stood still leaves no trace in that history, so the rebuild
// silently reports it as never done — and the project's own "one layer,
// one commit" rule is broken.
//
// This script builds a throwaway Hedgehog project in a temp dir, drives
// it through the real CLI (db init → intent add → plan → claim → verify),
// and checks two paths:
//
//   Case A (the bug): a layer whose work was already satisfied upstream.
//                     Nothing is written into its scope. Verify passes.
//                     Expect: a commit carrying the layer's commit_message.
//   Case B (control): the next layer, with a real file written into its
//                     scope — the ordinary path, asserted so a fix for
//                     Case A can't quietly break it.
//
// No sqlite3 binary and no test framework are used: node:sqlite reads the
// build graph back, assertions are plain, and the process exits nonzero
// on the first failure.
//
// Usage:  node repro/no-op-layer-commit.mjs        (add --keep to retain the temp dir)

import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  if (pass) {
    console.log(`  PASS  ${label}`);
    console.log(`        expected: ${expected}`);
    console.log(`        actual:   ${actual}`);
    return true;
  }
  console.log(`  FAIL  ${label}`);
  console.log(`        expected: ${expected}`);
  console.log(`        actual:   ${actual}`);
  failures.push(label);
  return false;
}

// ------------------------------------------------------------------- helpers

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function hedgehog(cwd, args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function headSha(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']);
}

function subjectOf(cwd, sha) {
  return git(cwd, ['log', '-1', '--format=%s', sha]);
}

function bodyOf(cwd, sha) {
  return git(cwd, ['log', '-1', '--format=%b', sha]);
}

// Paths a commit changed relative to its first parent. An empty list means
// an empty commit.
function filesInCommit(cwd, sha) {
  const out = git(cwd, ['show', '--pretty=format:', '--name-only', sha]);
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function taskStatus(dbPath, taskId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
    return row ? row.status : '(no such task)';
  } finally {
    db.close();
  }
}

// The `artifacts` rows verify wrote for a task, each carrying the sha of
// the commit that landed it — the provenance trail a rebuild leans on.
function artifactShas(dbPath, taskId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare('SELECT path, commit_sha FROM artifacts WHERE task_id = ? ORDER BY path')
      .all(taskId);
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------- fixture

// Two layers on one module. Both verify with `true` (exit 0) so the gate
// under test is the commit step, not the layer's own command.
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

// `.hedgehog/hedgehog.db` and the commit lock are engine state. verify.mjs
// excludes them from every scope diff already; ignoring them here matches
// how a real Hedgehog project is set up.
const GITIGNORE = `.hedgehog/hedgehog.db
.hedgehog/hedgehog.db-*
.hedgehog/commit.lock
.hedgehog/graph.pid
`;

function setupProject() {
  const root = mkdtempSync(join(tmpdir(), 'hedgehog-repro-'));

  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'repro@example.com']);
  git(root, ['config', 'user.name', 'Hedgehog Repro']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  // Ignore any host-level hooks so a stray commitlint can't colour the result.
  git(root, ['config', 'core.hooksPath', '/dev/null']);

  mkdirSync(join(root, '.hedgehog'), { recursive: true });
  writeFileSync(join(root, '.hedgehog', 'core.yaml'), CORE_YAML);
  writeFileSync(join(root, '.gitignore'), GITIGNORE);

  // The core definition has to be committed, or it shows up as an
  // untracked path in the very scope diff verify runs.
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'chore: bootstrap repro project']);

  return root;
}

// `hedgehog plan` (the CLI command) spawns a detached graph server and
// opens a browser on success. The compile itself is planTasks(), imported
// here directly so the reproduction stays headless and leaves no stray
// process behind. Same code path, minus the UI.
async function planTasksHeadless(root) {
  const { loadCore } = await import(join(REPO_ROOT, 'src', 'db', 'core.mjs'));
  const { planTasks } = await import(join(REPO_ROOT, 'src', 'db', 'plan.mjs'));
  const { openDb } = await import(join(REPO_ROOT, 'src', 'db', 'init.mjs'));

  const core = await loadCore(join(root, '.hedgehog', 'core.yaml'));
  const cwd = process.cwd();
  process.chdir(root); // openDb resolves .hedgehog/hedgehog.db against cwd
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

// ---------------------------------------------------------------------- main

async function main() {
  const root = setupProject();
  const dbPath = join(root, '.hedgehog', 'hedgehog.db');
  console.log(`project: ${root}\n`);

  hedgehog(root, ['db', 'init']);
  hedgehog(root, [
    'intent', 'add',
    '--id', 'demo',
    '--goal', 'exercise a layer with nothing left to do',
    '--outcome', 'both layers close complete',
  ]);
  // `.hedgehog/intents/*.json` are committed sources (they are what
  // `hedgehog db rebuild` replays), so commit them the way a real project
  // does — otherwise they sit untracked and trip verify's scope gate.
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'chore: add demo intent']);

  await planTasksHeadless(root);

  // ------------------------------------------------------- Case A: the no-op
  console.log('Case A — layer verifies with nothing touched\n');

  const claimA = hedgehog(root, ['claim', '--owner', 'repro']);
  if (!claimA.includes('DEMO-FOUNDATION')) {
    console.error(`could not claim DEMO-FOUNDATION; claim said:\n${claimA}`);
    process.exit(2);
  }

  // The layer is a legitimate no-op: the agent writes nothing at all.
  const dirtyBefore = git(root, ['status', '--porcelain']);
  if (dirtyBefore !== '') {
    console.error(`working tree should be clean before the no-op verify, got:\n${dirtyBefore}`);
    process.exit(2);
  }

  const headBeforeA = headSha(root);
  const verifyOutA = hedgehog(root, ['verify', 'DEMO-FOUNDATION', '--owner', 'repro']);
  const headAfterA = headSha(root);

  console.log(`  hedgehog verify said: ${verifyOutA.trim().split('\n')[0]}`);
  console.log(`  HEAD before: ${headBeforeA}`);
  console.log(`  HEAD after:  ${headAfterA}\n`);

  check('the task closed complete', {
    expected: 'complete',
    actual: taskStatus(dbPath, 'DEMO-FOUNDATION'),
    pass: taskStatus(dbPath, 'DEMO-FOUNDATION') === 'complete',
  });

  const movedA = headAfterA !== headBeforeA;
  check('a commit was written for the no-op layer (HEAD moved)', {
    expected: `HEAD to advance past ${headBeforeA.slice(0, 8)}`,
    actual: movedA ? `HEAD advanced to ${headAfterA.slice(0, 8)}` : 'HEAD unchanged — no commit written',
    pass: movedA,
  });

  if (movedA) {
    const subject = subjectOf(root, headAfterA);
    check("the commit carries the layer's commit_message", {
      expected: 'chore(infra): foundation for demo',
      actual: subject,
      pass: subject === 'chore(infra): foundation for demo',
    });

    // Checked word for word, not merely "non-empty": the note is
    // interpolated into a shell command, so a backtick or a `$` in it
    // would be silently eaten (or executed) rather than committed.
    const body = bodyOf(root, headAfterA).trim();
    const NOTE =
      'Verified no-op: this layer had nothing left to change. Recorded as an ' +
      'empty commit so one layer still means one commit, and so the completion ' +
      'survives a "hedgehog db rebuild", which replays git history.';
    check('the commit records, verbatim, that the layer was a verified no-op', {
      expected: NOTE,
      actual: body === '' ? '(empty body)' : body,
      pass: body === NOTE,
    });

    const files = filesInCommit(root, headAfterA);
    check('the no-op commit is empty (touches no files)', {
      expected: '0 files',
      actual: `${files.length} file(s)${files.length ? ': ' + files.join(', ') : ''}`,
      pass: files.length === 0,
    });
  }

  // The whole point: git alone has to be enough to reconstruct completion.
  const reconstructible = git(root, ['log', '--format=%s'])
    .split('\n')
    .includes('chore(infra): foundation for demo');
  check('completion is reconstructible from git history alone', {
    expected: "'chore(infra): foundation for demo' present in git log",
    actual: reconstructible ? 'present' : 'absent — a db rebuild would show this task as never done',
    pass: reconstructible,
  });

  // ------------------------------------------------ Case B: the normal path
  console.log('\nCase B — control: layer writes a real file (must keep working)\n');

  const claimB = hedgehog(root, ['claim', '--owner', 'repro']);
  if (!claimB.includes('DEMO-IMPL')) {
    console.error(`could not claim DEMO-IMPL; claim said:\n${claimB}`);
    process.exit(2);
  }

  mkdirSync(join(root, 'modules', 'demo', 'impl'), { recursive: true });
  writeFileSync(join(root, 'modules', 'demo', 'impl', 'thing.txt'), 'real work\n');

  const headBeforeB = headSha(root);
  hedgehog(root, ['verify', 'DEMO-IMPL', '--owner', 'repro']);
  const headAfterB = headSha(root);

  console.log(`  HEAD before: ${headBeforeB}`);
  console.log(`  HEAD after:  ${headAfterB}\n`);

  check('the control task closed complete', {
    expected: 'complete',
    actual: taskStatus(dbPath, 'DEMO-IMPL'),
    pass: taskStatus(dbPath, 'DEMO-IMPL') === 'complete',
  });

  const movedB = headAfterB !== headBeforeB;
  check('a commit was written for the normal layer (HEAD moved)', {
    expected: `HEAD to advance past ${headBeforeB.slice(0, 8)}`,
    actual: movedB ? `HEAD advanced to ${headAfterB.slice(0, 8)}` : 'HEAD unchanged — no commit written',
    pass: movedB,
  });

  if (movedB) {
    const subjectB = subjectOf(root, headAfterB);
    check("the control commit carries the layer's commit_message", {
      expected: 'feat(demo): impl',
      actual: subjectB,
      pass: subjectB === 'feat(demo): impl',
    });

    const filesB = filesInCommit(root, headAfterB);
    check('the control commit contains exactly the touched file', {
      expected: 'modules/demo/impl/thing.txt',
      actual: filesB.length ? filesB.join(', ') : '(empty commit)',
      pass: filesB.length === 1 && filesB[0] === 'modules/demo/impl/thing.txt',
    });

    const bodyB = bodyOf(root, headAfterB).trim();
    check('the control commit is NOT annotated as a no-op', {
      expected: '(empty body)',
      actual: bodyB === '' ? '(empty body)' : bodyB,
      pass: bodyB === '',
    });

    const artifacts = artifactShas(dbPath, 'DEMO-IMPL');
    const ok =
      artifacts.length === 1 &&
      artifacts[0].path === 'modules/demo/impl/thing.txt' &&
      artifacts[0].commit_sha === headAfterB;
    check('the artifact row points at the control commit', {
      expected: `modules/demo/impl/thing.txt @ ${headAfterB.slice(0, 8)}`,
      actual: artifacts.length
        ? artifacts.map((a) => `${a.path} @ ${String(a.commit_sha).slice(0, 8)}`).join(', ')
        : '(no artifact rows)',
      pass: ok,
    });
  }

  // ------------------------------------- Case C: the consequence, end to end
  //
  // This is what the whole bug is about. src/db/rebuild.mjs marks a task
  // complete iff some commit's subject exactly matches its commit_message.
  // Throw the derived database away and rebuild it from the committed
  // intents plus git history — exactly what a fresh clone does — and both
  // layers must come back complete.
  console.log('\nCase C — throw the derived db away and rebuild from git alone\n');

  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });

  const rebuildOut = hedgehog(root, ['db', 'rebuild']);
  console.log(`  ${rebuildOut.trim().split('\n').filter(Boolean).join('\n  ')}\n`);

  for (const id of ['DEMO-FOUNDATION', 'DEMO-IMPL']) {
    const status = taskStatus(dbPath, id);
    check(`${id} survives the rebuild as complete`, {
      expected: 'complete',
      actual: status,
      pass: status === 'complete',
    });
  }

  // ------------------------------------------------------------------ result
  console.log();
  if (KEEP) {
    console.log(`kept project at ${root}\n`);
  } else {
    rmSync(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.log(`REPRO FAILED — ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log();
    process.exit(1);
  }

  console.log('REPRO PASSED — every layer that verified left a commit behind.\n');
}

main().catch((err) => {
  console.error('repro crashed:');
  console.error(err.stack ?? String(err));
  process.exit(2);
});
