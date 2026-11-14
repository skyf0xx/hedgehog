#!/usr/bin/env node
// Reproduction: with nothing in its own scope touched, a layer whose check
// reaches beyond its own edits still runs verify_command — an `exclusive`
// join and a layer that declares a `verify_radius`. A failing command
// blocks the task; a passing one closes it as a no-op with no commit. A
// plain layer seeing its scope untouched for the first time still closes
// as a no-op without running its command, even one that would fail.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, addIntent, cli, taskStatuses, openGraph, cleanup, check, checkContains, report } from './_lib.mjs';

const coreFor = ({ joinVerify, radiusVerify, plainVerify }) => `
id: noop-wide-checks
layers:
  - id: schema
    scope: ["libs/{module}/schema/**"]
    verify: "true"
    commit: "feat({module}): schema"
  - id: plain
    depends_on: schema
    scope: ["libs/{module}/plain/**"]
    verify: "${plainVerify}"
    commit: "feat({module}): plain"
  - id: radius
    depends_on: plain
    scope: ["libs/{module}/radius/**"]
    verify_radius: ["libs/{module}/**"]
    verify: "${radiusVerify}"
    commit: "feat({module}): radius"
  - id: join
    depends_on: radius
    scope: ["**"]
    exclusive: true
    verify: "${joinVerify}"
    commit: "chore({module}): join"
`;

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
const head = (dir) => git(dir, ['rev-parse', 'HEAD']);

function verificationRows(dir, taskId) {
  const db = openGraph(dir);
  try {
    return db.prepare('SELECT status FROM verifications WHERE task_id = ? ORDER BY id').all(taskId).map((r) => r.status);
  } finally {
    db.close();
  }
}

function setup(core) {
  const dir = makeProject(core, { git: true });
  writeFileSync(join(dir, '.gitignore'), '.hedgehog/hedgehog.db*\n.hedgehog/commit.lock\n.hedgehog/graph-server.json\n*.marker\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'chore: ignore graph']);
  addIntent(dir, 'sassy');
  cli(dir, ['plan']);
  cli(dir, ['claim', 'SASSY-SCHEMA', '--owner', 'o']);
  mkdirSync(join(dir, 'libs/sassy/schema'), { recursive: true });
  writeFileSync(join(dir, 'libs/sassy/schema/a'), 'x');
  cli(dir, ['verify', 'SASSY-SCHEMA', '--owner', 'o']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'chore: graph state']);
  return dir;
}

function claimAndVerify(dir, taskId) {
  cli(dir, ['claim', taskId, '--owner', 'o']);
  return cli(dir, ['verify', taskId, '--owner', 'o']);
}

console.log('failing checks on a clean tree:');
let dir = setup(coreFor({ joinVerify: 'false', radiusVerify: 'true', plainVerify: 'touch plain.marker; false' }));
try {
  claimAndVerify(dir, 'SASSY-PLAIN');
  check('plain first-time no-op completes', 'complete', taskStatuses(dir)['SASSY-PLAIN']);
  check('plain no-op never ran its (failing) command', false, existsSync(join(dir, 'plain.marker')));
  check('plain no-op wrote no verifications row', [], verificationRows(dir, 'SASSY-PLAIN'));

  claimAndVerify(dir, 'SASSY-RADIUS');
  const before = head(dir);
  const r = claimAndVerify(dir, 'SASSY-JOIN');
  check('exclusive join with a failing check blocks', 'blocked', taskStatuses(dir)['SASSY-JOIN']);
  check('the failed run is recorded', ['failed'], verificationRows(dir, 'SASSY-JOIN'));
  checkContains('the CLI reports the failure', r.stderr, 'Verification failed.');
  check('no commit on the failed join', before, head(dir));
} finally {
  cleanup(dir);
}

dir = setup(coreFor({ joinVerify: 'touch join.marker', radiusVerify: 'false', plainVerify: 'true' }));
try {
  claimAndVerify(dir, 'SASSY-PLAIN');
  claimAndVerify(dir, 'SASSY-RADIUS');
  check('verify_radius layer with a failing check blocks', 'blocked', taskStatuses(dir)['SASSY-RADIUS']);
  check('the failed radius run is recorded', ['failed'], verificationRows(dir, 'SASSY-RADIUS'));
} finally {
  cleanup(dir);
}

console.log('passing checks on a clean tree:');
dir = setup(coreFor({ joinVerify: 'touch join.marker', radiusVerify: 'touch radius.marker', plainVerify: 'true' }));
try {
  claimAndVerify(dir, 'SASSY-PLAIN');
  const before = head(dir);
  const radius = claimAndVerify(dir, 'SASSY-RADIUS');
  check('verify_radius layer completes', 'complete', taskStatuses(dir)['SASSY-RADIUS']);
  check('verify_radius layer ran its command', true, existsSync(join(dir, 'radius.marker')));
  checkContains('the CLI says the check ran', radius.stdout, 'verify command passed; nothing in scope to commit');
  const join_ = claimAndVerify(dir, 'SASSY-JOIN');
  check('exclusive join completes', 'complete', taskStatuses(dir)['SASSY-JOIN']);
  check('exclusive join ran its command', true, existsSync(join(dir, 'join.marker')));
  check('the passed run is recorded', ['passed'], verificationRows(dir, 'SASSY-JOIN'));
  checkContains('the CLI says the check ran', join_.stdout, 'verify command passed; nothing in scope to commit');
  check('no commit for either no-op', before, head(dir));
  check('no-op record written for the join', true, existsSync(join(dir, '.hedgehog/noop/sassy-join.json')));
} finally {
  cleanup(dir);
}

report('a no-op close still runs the check on exclusive and verify_radius layers');
