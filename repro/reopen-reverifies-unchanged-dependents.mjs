#!/usr/bin/env node
// Reproduction: `hedgehog reopen <task> --confirm` sends complete
// dependents back through claim and verify, and that re-verification runs
// each dependent's verify_command even when the dependent has nothing in
// scope to change. A dependent that first closed as a no-op can be
// verified again rather than being stuck in `verifying`. A `db rebuild`
// mid-correction keeps the reopened tasks open instead of crediting them
// from their original commits.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, addIntent, cli, taskStatuses, cleanup, check, checkContains, report } from './_lib.mjs';

const CORE = `
id: reopen-reverify
layers:
  - id: schema
    scope: ["libs/{module}/schema/**"]
    verify: "true"
    commit: "feat({module}): schema"
  - id: api
    depends_on: schema
    scope: ["apps/api/{module}/**"]
    verify: "echo run >> api.log"
    commit: "feat({module}): api"
  - id: smoke
    depends_on: api
    scope: ["tests/{module}/**"]
    verify: "echo run >> smoke.log"
    commit: "test({module}): smoke"
`;

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
const runs = (dir, log) => (existsSync(join(dir, log)) ? readFileSync(join(dir, log), 'utf8').trim().split('\n').length : 0);
const write = (dir, path) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), String(Math.random()));
};
const claimAndVerify = (dir, taskId) => {
  cli(dir, ['claim', taskId, '--owner', 'o']);
  return cli(dir, ['verify', taskId, '--owner', 'o']);
};
const ALL = ['SASSY-API', 'SASSY-SCHEMA', 'SASSY-SMOKE'];
const statuses = (dir) => ALL.map((id) => taskStatuses(dir)[id]);

const dir = makeProject(CORE, { git: true });
try {
  writeFileSync(join(dir, '.gitignore'), '.hedgehog/hedgehog.db*\n.hedgehog/commit.lock\n.hedgehog/graph-server.json\n*.log\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'chore: ignore graph']);
  addIntent(dir, 'sassy');
  cli(dir, ['plan']);

  cli(dir, ['claim', 'SASSY-SCHEMA', '--owner', 'o']);
  write(dir, 'libs/sassy/schema/a');
  cli(dir, ['verify', 'SASSY-SCHEMA', '--owner', 'o']);
  cli(dir, ['claim', 'SASSY-API', '--owner', 'o']);
  write(dir, 'apps/api/sassy/a');
  cli(dir, ['verify', 'SASSY-API', '--owner', 'o']);
  claimAndVerify(dir, 'SASSY-SMOKE');
  check('first pass: every task complete', ['complete', 'complete', 'complete'], statuses(dir));
  check('smoke first closed as a no-op without running its command', 0, runs(dir, 'smoke.log'));

  const reopen = cli(dir, ['reopen', 'SASSY-SCHEMA', '--confirm']);
  checkContains('reopen reports the chain', reopen.stdout, 'SASSY-SCHEMA, SASSY-API, SASSY-SMOKE');
  check('reopen records written', true, ALL.every((id) => existsSync(join(dir, `.hedgehog/reopened/${id.toLowerCase()}.json`))));

  cli(dir, ['db', 'rebuild']);
  check('a rebuild mid-correction keeps the reopened tasks open', [false, false, false], statuses(dir).map((s) => s === 'complete'));

  cli(dir, ['claim', 'SASSY-SCHEMA', '--owner', 'o']);
  write(dir, 'libs/sassy/schema/fixed');
  cli(dir, ['verify', 'SASSY-SCHEMA', '--owner', 'o']);
  check('the fix verifies', 'complete', taskStatuses(dir)['SASSY-SCHEMA']);
  check('its reopen record is cleared', false, existsSync(join(dir, '.hedgehog/reopened/sassy-schema.json')));

  const api = claimAndVerify(dir, 'SASSY-API');
  check('the unchanged dependent completes', 'complete', taskStatuses(dir)['SASSY-API']);
  check('the unchanged dependent ran its verify command again', 2, runs(dir, 'api.log'));
  checkContains('the CLI says the check ran', api.stdout, 'verify command passed; nothing in scope to commit');

  const smoke = claimAndVerify(dir, 'SASSY-SMOKE');
  check('the dependent that first closed as a no-op verifies again', 'complete', taskStatuses(dir)['SASSY-SMOKE']);
  check('and runs its verify command', 1, runs(dir, 'smoke.log'));
  check('verify did not fail', 0, smoke.status);

  cli(dir, ['db', 'rebuild']);
  check('after the correction, a rebuild credits every task', ['complete', 'complete', 'complete'], statuses(dir));
} finally {
  cleanup(dir);
}

report('a reopened dependent re-runs its verify command, and the reopen survives a rebuild');
