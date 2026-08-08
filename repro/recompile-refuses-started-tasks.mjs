#!/usr/bin/env node
// Repro 2 — `plan --recompile` must refuse to rewrite a task that has
// already been acted upon (building, verifying, complete), and must say
// which ones it skipped and why. A task already committed under its old
// commit_message can't have that message retro-changed; a task an agent
// is mid-build on can't have its ALLOWED SCOPE moved underneath it.

import {
  plannedProject,
  cleanupAll,
  scenario,
  mustSucceed,
  assertEqual,
  assertIncludes,
  CORE_YAML_AFTER,
  VERIFY_BEFORE,
  VERIFY_AFTER,
} from './lib.mjs';

let ok = true;

for (const [status, owner] of [
  ['building', 'agent-a'],
  ['verifying', 'agent-a'],
  ['complete', null],
]) {
  ok =
    scenario(`plan --recompile refuses a '${status}' task and says why`, () => {
      const p = plannedProject('billing');
      p.setStatus('BILLING-FOUNDATION', status, owner);
      p.writeCore(CORE_YAML_AFTER);

      const r = mustSucceed(p.run('plan', '--recompile'), 'hedgehog plan --recompile');

      const after = p.task('BILLING-FOUNDATION');
      assertEqual(after.verify_command, VERIFY_BEFORE, `verify_command on a '${status}' task is untouched`);
      assertEqual(after.status, status, 'status is untouched');

      assertIncludes(r.out, 'BILLING-FOUNDATION', '--recompile names the task it skipped');
      assertIncludes(r.out, status, '--recompile names the status that made it refuse');
      assertIncludes(r.out, 'skipped', '--recompile labels it as skipped');
    }) && ok;
}

ok =
  scenario('a not-started sibling still recompiles when another task is refused', () => {
    // Two intents through the same layer chain: one whose foundation
    // task is already complete (must be refused) and one still planned
    // (must be updated). One run, both outcomes.
    const p = plannedProject('billing');
    mustSucceed(
      p.run('intent', 'add', '--id', 'ledger', '--goal', 'g', '--outcome', 'o'),
      'hedgehog intent add ledger',
    );
    mustSucceed(p.run('plan'), 'hedgehog plan (ledger)');

    p.setStatus('BILLING-FOUNDATION', 'complete');
    p.writeCore(CORE_YAML_AFTER);

    const r = mustSucceed(p.run('plan', '--recompile'), 'hedgehog plan --recompile');

    assertEqual(
      p.task('BILLING-FOUNDATION').verify_command,
      VERIFY_BEFORE,
      'complete task refused',
    );
    assertEqual(
      p.task('LEDGER-FOUNDATION').verify_command,
      'PATH=/usr/local/bin:$PATH node --test infra/ledger',
      'not-started sibling of another intent is updated',
    );
    assertIncludes(r.out, 'updated', 'the run reports an update');
    assertIncludes(r.out, 'skipped', 'the same run reports a refusal');
  }) && ok;

ok =
  scenario('--recompile exits non-zero if asked to touch only refused tasks with --strict', () => {
    const p = plannedProject('billing');
    p.setStatus('BILLING-FOUNDATION', 'complete');
    p.writeCore(CORE_YAML_AFTER);
    const r = p.run('plan', '--recompile', '--strict');
    assertEqual(r.code, 1, '--strict exit code when drift remains unreconciled');
    assertIncludes(r.out, VERIFY_AFTER, '--strict run still reports what core.yaml now says');
  }) && ok;

cleanupAll();
process.exit(ok ? 0 : 1);
