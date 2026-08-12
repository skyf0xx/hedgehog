#!/usr/bin/env node
// Repro 3 — drift must be visible before anyone recompiles. `hedgehog
// status` is the command every session already starts with, so a
// core.yaml that no longer matches the compiled tasks has to show up
// there, naming the tasks and fields that diverged.
//
// The same argument covers the other whole-graph condition `status`
// owns: an override naming a task id that doesn't exist widens nothing,
// throws nothing, and produces no drift, so `status` is the only place
// an operator who isn't already suspicious will find it.
//
// And it covers the two append-only side channels. Declared debt and
// logged friction are reachable only through `debt list <task>` (which
// needs a task id the operator has no way to guess) and `friction list`
// (which needs the operator to already suspect there is something to
// read), so a graph carrying either looks perfectly healthy from
// `status` unless `status` says so.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  plannedProject,
  cleanupAll,
  scenario,
  mustSucceed,
  assertIncludes,
  assertNotIncludes,
  CORE_YAML_AFTER,
} from './drift-lib.mjs';

// Writes one `.hedgehog/overrides/*.json` record directly rather than
// going through `hedgehog override add`, so a scenario can name a task
// id that doesn't exist — which is exactly the state under test and the
// one the CLI's own validation has no opinion about.
function writeOverride(p, taskId, scopeAdd) {
  mkdirSync(join(p.dir, '.hedgehog/overrides'), { recursive: true });
  writeFileSync(
    join(p.dir, `.hedgehog/overrides/${taskId.toLowerCase()}.json`),
    JSON.stringify({ task: taskId, scope_add: [scopeAdd], reason: 'repro' }, null, 2),
  );
}

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

ok =
  scenario('status is quiet when every override names a real task', () => {
    const p = plannedProject('billing');
    writeOverride(p, 'BILLING-FOUNDATION', 'infra/billing.manifest.json');
    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertNotIncludes(r.out, 'ORPHANED OVERRIDES', 'a matching override raises nothing');
  }) && ok;

ok =
  scenario('status reports an override whose task id matches nothing', () => {
    const p = plannedProject('billing');
    writeOverride(p, 'BILLING-FONUDATION', 'infra/billing.manifest.json');

    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertIncludes(r.out, 'ORPHANED OVERRIDES', 'status names the orphaned-override section');
    assertIncludes(r.out, 'BILLING-FONUDATION', 'status names the typo\'d task id');
    assertIncludes(r.out, 'widens nothing', 'status states the consequence');
  }) && ok;

// The orphan check reads task ids out of the database, not core.yaml, so
// an unreadable core must not suppress it — that gap is what made a dead
// override reachable only by already knowing to run `override list`.
ok =
  scenario('an orphaned override is reported even with no readable core', () => {
    const p = plannedProject('billing');
    writeOverride(p, 'BILLING-FONUDATION', 'infra/billing.manifest.json');
    p.writeCore('id: repro-core\nlayers: [\n');

    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertIncludes(r.out, 'ORPHANED OVERRIDES', 'the section survives an unparseable core.yaml');
    assertIncludes(r.out, 'BILLING-FONUDATION', 'the orphaned id is still named');
  }) && ok;

ok =
  scenario('status is quiet when nothing has been declared or logged', () => {
    const p = plannedProject('billing');
    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertNotIncludes(r.out, 'DECLARED DEBT', 'no debt section on a graph with no debt');
    assertNotIncludes(r.out, 'FRICTION LOGGED', 'no friction section on a graph with none');
  }) && ok;

ok =
  scenario('status reports declared debt and names the declaring task', () => {
    const p = plannedProject('billing');
    mustSucceed(
      p.run('debt', 'add', 'BILLING-FOUNDATION', 'manifest is hand-rolled'),
      'hedgehog debt add',
    );

    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertIncludes(r.out, 'DECLARED DEBT', 'status names the debt section');
    assertIncludes(r.out, 'BILLING-FOUNDATION', 'status names the declaring task');
    assertIncludes(r.out, 'hedgehog debt list', 'status points at the listing command');
    // The count is the altitude here: `debt list` owns the notes, and a
    // status overview that reprints them is that command with extra steps.
    assertNotIncludes(r.out, 'manifest is hand-rolled', 'the note text stays in debt list');
  }) && ok;

// Two rows against one task collapse to one line — the per-task count is
// what makes `debt list <task>` reachable, and one line per note would
// turn the overview back into the listing it defers to.
ok =
  scenario('multiple debt notes on one task collapse to a count', () => {
    const p = plannedProject('billing');
    mustSucceed(p.run('debt', 'add', 'BILLING-FOUNDATION', 'first'), 'hedgehog debt add');
    mustSucceed(p.run('debt', 'add', 'BILLING-FOUNDATION', 'second'), 'hedgehog debt add');

    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertIncludes(r.out, 'DECLARED DEBT  2', 'the section header carries the row total');
    assertIncludes(r.out, '2 notes', 'the declaring task carries its own count');
  }) && ok;

ok =
  scenario('status reports logged friction', () => {
    const p = plannedProject('billing');
    mustSucceed(p.run('friction', 'add', 'plan --recompile was hard to find'), 'hedgehog friction add');

    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertIncludes(r.out, 'FRICTION LOGGED  1', 'status counts the friction row');
    assertIncludes(r.out, 'hedgehog friction list', 'status points at the listing command');
  }) && ok;

// A friction row's task_id is nullable — tweaker's reviewed-marker row
// has none. The count is whole-project, so a row with no task must land
// in it rather than being dropped for lacking an id to attribute it to.
ok =
  scenario('friction with no task id is still counted', () => {
    const p = plannedProject('billing');
    mustSucceed(p.run('friction', 'add', 'attributed', '--task', 'BILLING-FOUNDATION'), 'hedgehog friction add');
    mustSucceed(p.run('friction', 'add', 'reviewed: 2026-01-01, issues: none filed'), 'hedgehog friction add');

    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertIncludes(r.out, 'FRICTION LOGGED  2', 'both rows count, with and without a task');
  }) && ok;

// Neither table has a resolved column, so the report must not claim a
// state the schema can't back — nothing here is "open" or "unresolved",
// only declared and logged.
ok =
  scenario('neither section claims an open/unresolved state', () => {
    const p = plannedProject('billing');
    mustSucceed(p.run('debt', 'add', 'BILLING-FOUNDATION', 'a note'), 'hedgehog debt add');
    mustSucceed(p.run('friction', 'add', 'a friction note'), 'hedgehog friction add');

    const r = mustSucceed(p.run('status'), 'hedgehog status');
    assertIncludes(r.out, 'DECLARED DEBT', 'debt is reported as declared');
    assertIncludes(r.out, 'FRICTION LOGGED', 'friction is reported as logged');
    assertNotIncludes(r.out, 'OPEN DEBT', 'debt is declared, not open');
    assertNotIncludes(r.out, 'UNRESOLVED', 'friction is logged, not unresolved');
  }) && ok;

cleanupAll();
process.exit(ok ? 0 : 1);
