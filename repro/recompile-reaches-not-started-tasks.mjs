#!/usr/bin/env node
// Repro 1 — a core.yaml correction must reach tasks that have not
// started, via `hedgehog plan --recompile`.
//
// Against v4.0.3 this fails twice over: `--recompile` is not a flag
// `plan` knows, and plain `plan` recompiles nothing because the intent
// went `active` the first time round.

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

ok =
  scenario('plan --recompile rewrites layer-derived fields on not-started tasks', () => {
    const p = plannedProject('billing');

    const before = p.task('BILLING-FOUNDATION');
    assertEqual(before.verify_command, VERIFY_BEFORE, 'baseline verify_command from `hedgehog plan`');
    assertEqual(before.status, 'planned', 'baseline task status');

    // The correction the operator makes to core.yaml.
    p.writeCore(CORE_YAML_AFTER);

    // Today's only "reconcile" path — re-running plan — is a no-op, and
    // says so. This assertion documents the bug rather than the fix.
    const replan = p.run('plan');
    assertIncludes(replan.out, '0 intent(s) compiled', 'plain `plan` after a core.yaml edit compiles nothing');

    const recompile = mustSucceed(p.run('plan', '--recompile'), 'hedgehog plan --recompile');

    const after = p.task('BILLING-FOUNDATION');
    assertEqual(after.verify_command, VERIFY_AFTER, 'verify_command after --recompile');
    assertEqual(
      after.scope_globs,
      JSON.stringify(['infra/billing/**', 'infra/billing.manifest.json']),
      'scope_globs after --recompile',
    );

    // The untouched layer must stay untouched.
    const api = p.task('BILLING-API');
    assertEqual(api.verify_command, 'node --test apps/api/src/billing', 'unrelated layer left alone');

    assertIncludes(recompile.out, 'BILLING-FOUNDATION', '--recompile names the task it changed');
    assertIncludes(recompile.out, 'verify_command', '--recompile names the field it changed');
  }) && ok;

ok =
  scenario('a second --recompile is a no-op once the graph matches core.yaml', () => {
    const p = plannedProject('billing');
    p.writeCore(CORE_YAML_AFTER);
    mustSucceed(p.run('plan', '--recompile'), 'first --recompile');
    const second = mustSucceed(p.run('plan', '--recompile'), 'second --recompile');
    assertIncludes(second.out, '0 task(s) updated', 'second --recompile reports nothing to do');
  }) && ok;

cleanupAll();
process.exit(ok ? 0 : 1);
