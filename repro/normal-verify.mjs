#!/usr/bin/env node
// No-regression harness for `hedgehog verify`, run against the real CLI
// on throwaway projects. Nothing here involves a payload — the point is
// that swapping `execSync` for `execFileSync` in src/db/verify.mjs left
// ordinary behaviour byte-for-byte identical. This script passes both
// before and after the fix.
//
// Covered:
//   1. the happy path — multi-glob scope, `:(glob)` semantics, created vs
//      modified artifact classification, exact commit subject, exactly
//      the in-scope files staged, task `complete`, exit 0
//   2. paths that are awkward for a shell but legitimate for git — spaces
//      and quotes in a file name — still classified, staged and committed
//   3. a touched path outside scope — `scope_violation`, exit 1, no commit
//   4. a failing verify_command — `verification_failed`, exit 1, no commit
//   5. a layer that touches nothing — no commit, still `complete`
//
// Every project lives inside its own `mkdtemp` directory.

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { CLI, git, hedgehog, makeProject, makeReporter } from './fixture.mjs';

const report = makeReporter();

function write(repo, path, contents) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), contents);
}

function committedFiles(repo) {
  return git(repo, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').filter(Boolean).sort();
}

function readGraph(repo, taskId) {
  const db = new DatabaseSync(join(repo, '.hedgehog', 'hedgehog.db'), { readOnly: true });
  try {
    const task = db.prepare('SELECT status, blocked_reason FROM tasks WHERE id = ?').get(taskId);
    const artifacts = db
      .prepare('SELECT path, kind FROM artifacts WHERE task_id = ? ORDER BY path')
      .all(taskId);
    return { task, artifacts };
  } finally {
    db.close();
  }
}

// ── 1. Happy path ──────────────────────────────────────────────────────
function happyPath() {
  console.log('\n1 — happy path: multi-glob scope, created + modified, exact commit');
  const subject = 'feat(demo): layer';
  const { repo, taskId } = makeProject({
    scope: 'src/**, docs/**',
    commit: subject,
    seed: { 'src/existing.ts': 'export const existing = 0;\n', 'docs/old.md': 'old\n' },
  });

  write(repo, 'src/existing.ts', 'export const existing = 1;\n');
  write(repo, 'src/nested/new.ts', 'export const created = 1;\n');
  write(repo, 'docs/new.md', 'new\n');

  const res = hedgehog(repo, ['verify', taskId, '--owner', 'repro']);
  const { task, artifacts } = readGraph(repo, taskId);

  report.check('1', 'verify exits 0', 0, res.status);
  report.check('1', 'commit subject is exactly the core.yaml message', subject, git(repo, ['log', '-1', '--format=%s']).trim());
  report.check('1', 'exactly the in-scope files are committed', ['docs/new.md', 'src/existing.ts', 'src/nested/new.ts'], committedFiles(repo));
  report.check('1', 'task is complete', { status: 'complete', blocked_reason: null }, task);
  report.check(
    '1',
    'artifacts classified created vs modified',
    [
      { path: 'docs/new.md', kind: 'created' },
      { path: 'src/existing.ts', kind: 'modified' },
      { path: 'src/nested/new.ts', kind: 'created' },
    ],
    artifacts,
  );
  report.check('1', 'working tree is clean afterwards', '', git(repo, ['status', '--porcelain']).trim());
}

// ── 2. Shell-awkward but legitimate file names ─────────────────────────
// Spaces, semicolons, ampersands, parentheses, quotes, a leading dash.
// Every one of these is inert inside the old double-quoted command line
// *and* inert as an argv entry, so this scenario passes identically
// before and after the fix — which is exactly what makes it useful as a
// no-regression check rather than a second injection test.
//
// Deliberately excluded: a `"` in a file name. `git ls-files --others`
// C-quotes such a path on output, so verify.mjs reads back the literal
// `"src/has\"quote.ts"` (outer quotes included) and the subsequent `git
// add` fails. That is a pre-existing path-decoding bug, present
// identically before and after this change, and out of scope here.
function awkwardNames() {
  console.log('\n2 — file names that are awkward for a shell but legal for git');
  const { repo, taskId } = makeProject({
    scope: 'src/**',
    commit: 'feat(demo): layer',
    seed: { 'src/keep.ts': 'export const keep = 0;\n' },
  });

  const names = [
    'src/a file.ts',
    'src/semi;colon.ts',
    'src/amp&and.ts',
    'src/paren(1).ts',
    "src/it's.ts",
    'src/-leading-dash.ts',
  ];
  for (const n of names) write(repo, n, 'export const x = 1;\n');

  const res = hedgehog(repo, ['verify', taskId, '--owner', 'repro']);
  const { task, artifacts } = readGraph(repo, taskId);

  report.check('2', 'verify exits 0', 0, res.status);
  report.check('2', 'every awkward name is committed', [...names].sort(), committedFiles(repo));
  report.check('2', 'task is complete', 'complete', task?.status);
  report.check('2', 'every awkward name is recorded as created', [...names].sort().map((path) => ({ path, kind: 'created' })), artifacts);
}

// ── 3. Scope violation ─────────────────────────────────────────────────
function scopeViolation() {
  console.log('\n3 — a touched path outside scope');
  const { repo, taskId } = makeProject({ scope: 'src/**', commit: 'feat(demo): layer' });
  const headBefore = git(repo, ['rev-parse', 'HEAD']).trim();

  write(repo, 'src/ok.ts', 'export const ok = 1;\n');
  write(repo, 'outside/bad.ts', 'export const bad = 1;\n');

  const res = hedgehog(repo, ['verify', taskId, '--owner', 'repro']);
  const { task } = readGraph(repo, taskId);

  report.check('3', 'verify exits 1', 1, res.status);
  report.check('3', 'the offending path is reported', true, res.stderr.includes('outside/bad.ts'));
  report.check('3', 'task is blocked with scope_violation', { status: 'blocked', blocked_reason: 'scope_violation' }, task);
  report.check('3', 'no commit landed', headBefore, git(repo, ['rev-parse', 'HEAD']).trim());
}

// ── 4. Failing verify_command ──────────────────────────────────────────
// Also pins that verify_command is still run through a shell, on purpose:
// `exit 3` is shell syntax, not an executable.
function verifyFailure() {
  console.log('\n4 — a failing verify_command (still a shell command by design)');
  const { repo, taskId } = makeProject({
    scope: 'src/**',
    verify: 'echo boom && exit 3',
    commit: 'feat(demo): layer',
  });
  const headBefore = git(repo, ['rev-parse', 'HEAD']).trim();

  write(repo, 'src/ok.ts', 'export const ok = 1;\n');
  const res = hedgehog(repo, ['verify', taskId, '--owner', 'repro']);
  const { task } = readGraph(repo, taskId);

  report.check('4', 'verify exits 1', 1, res.status);
  report.check('4', 'the shell exit code is surfaced', true, res.stderr.includes('exit 3'));
  report.check('4', 'verify_command output is captured', true, res.stderr.includes('boom'));
  report.check('4', 'task is blocked with verification_failed', { status: 'blocked', blocked_reason: 'verification_failed' }, task);
  report.check('4', 'no commit landed', headBefore, git(repo, ['rev-parse', 'HEAD']).trim());
}

// ── 5. A layer that touches nothing ────────────────────────────────────
function emptyChangeSet() {
  console.log('\n5 — a layer that touches nothing');
  const { repo, taskId } = makeProject({ scope: 'src/**', commit: 'feat(demo): layer' });
  const headBefore = git(repo, ['rev-parse', 'HEAD']).trim();

  const res = hedgehog(repo, ['verify', taskId, '--owner', 'repro']);
  const { task, artifacts } = readGraph(repo, taskId);

  report.check('5', 'verify exits 0', 0, res.status);
  report.check('5', 'no commit landed', headBefore, git(repo, ['rev-parse', 'HEAD']).trim());
  report.check('5', 'task is complete', 'complete', task?.status);
  report.check('5', 'no artifacts recorded', [], artifacts);
}

console.log('Hedgehog `hedgehog verify` no-regression harness');
console.log(`CLI under test: ${CLI}`);

happyPath();
awkwardNames();
scopeViolation();
verifyFailure();
emptyChangeSet();

report.finish('Ordinary `hedgehog verify` behaviour is unchanged.', 'REGRESSION — the following checks failed:');
