#!/usr/bin/env node
// Repro 3 — drift must be visible before anyone recompiles. `hedgehog
// status` is the command every session already starts with, so a
// core.yaml that no longer matches the compiled tasks has to show up
// there, naming the tasks and fields that diverged.
//
// Against v4.0.3 `status` prints counts + ready list only, and a
// divergent core.yaml is completely silent.

import {
  plannedProject,
  cleanupAll,
  scenario,
  mustSucceed,
  assertIncludes,
  assertNotIncludes,
  CORE_YAML_AFTER,
} from './lib.mjs';

let ok = true;

ok =
  scenario('status is quiet when the graph matches core.yaml', () => {
    const p = plannedProject('billing');
    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertNotIncludes(r.out, 'DRIFT', 'no drift section on a graph that matches its core');
  }) && ok;

ok =
  scenario('status reports drift after a core.yaml edit, before any recompile', () => {
    const p = plannedProject('billing');
    p.writeCore(CORE_YAML_AFTER);

    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertIncludes(r.out, 'DRIFT', 'status names the drift section');
    assertIncludes(r.out, 'BILLING-FOUNDATION', 'status names the drifted task');
    assertIncludes(r.out, 'verify_command', 'status names the drifted field');
    assertIncludes(r.out, 'scope_globs', 'status names the other drifted field');
    assertIncludes(r.out, 'plan --recompile', 'status points at the reconciliation command');
  }) && ok;

ok =
  scenario('status stops reporting drift once --recompile has run', () => {
    const p = plannedProject('billing');
    p.writeCore(CORE_YAML_AFTER);
    mustSucceed(p.run('plan', '--recompile'), 'hedgehog plan --recompile');
    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertNotIncludes(r.out, 'DRIFT', 'drift section gone after reconciling');
  }) && ok;

ok =
  scenario('drift on a task that cannot be recompiled is still reported', () => {
    const p = plannedProject('billing');
    p.setStatus('BILLING-FOUNDATION', 'complete');
    p.writeCore(CORE_YAML_AFTER);
    mustSucceed(p.run('plan', '--recompile'), 'hedgehog plan --recompile');
    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertIncludes(r.out, 'DRIFT', 'drift on a complete task keeps showing');
    assertIncludes(r.out, 'BILLING-FOUNDATION', 'the complete task is named');
  }) && ok;

cleanupAll();
process.exit(ok ? 0 : 1);
