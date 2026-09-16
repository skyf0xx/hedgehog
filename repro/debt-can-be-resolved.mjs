#!/usr/bin/env node
// Repro: a declared debt note must be resolvable, and once resolved it
// stops reaching dependent tasks' packets — issue #438.
//
// Before the fix, `debt add` was the only mutation the `debt` table
// supported: no `debt resolve`, and `INHERITED DEBT` rendered every debt
// row against an ancestor forever, even after a later layer fixed it.

import { makeFixture, writeInScope, assertIncludes, assertNotIncludes, report } from './packet-lib.mjs';

const NOTE =
  'Card.updatedAt is set by the caller, not the model — the service layer must stamp it';

const fx = makeFixture();
try {
  fx.run(['claim', '--owner', 'repro']);
  writeInScope(fx.dir, 'src/card/model/card.js', 'export const Card = {};\n');

  const added = fx.run(['debt', 'add', 'CARD-DOMAIN-MODEL', NOTE]);
  const debtId = added.match(/#(\d+)/)?.[1];
  if (!debtId) {
    console.error('  FAIL  `hedgehog debt add` did not print a debt id');
    process.exit(1);
  }

  fx.run(['verify', 'CARD-DOMAIN-MODEL', '--owner', 'repro']);

  const beforeResolve = fx.run(['next']);
  console.log('--- hedgehog next (before resolve) ---');
  console.log(beforeResolve);
  assertIncludes(beforeResolve, NOTE, 'the packet carries the debt note before resolution');
  assertIncludes(beforeResolve, 'open debt note', 'the packet reports an open-debt count before resolution');

  let resolved;
  try {
    resolved = fx.run(['debt', 'resolve', debtId, '--reason', 'domain-service layer stamps updatedAt now']);
  } catch (err) {
    console.error('  FAIL  `hedgehog debt resolve` is not a command');
    console.error(`    actual  : ${(err.stdout ?? '') + (err.stderr ?? '') || err.message}`);
    process.exit(1);
  }
  console.log('--- hedgehog debt resolve ---');
  console.log(resolved);
  assertIncludes(resolved, 'resolved', 'the resolve command reports success');

  const afterResolve = fx.run(['next']);
  console.log('--- hedgehog next (after resolve) ---');
  console.log(afterResolve);
  assertNotIncludes(afterResolve, NOTE, 'the resolved debt no longer reaches the packet');
  assertIncludes(afterResolve, '(none declared)', 'the packet shows no inherited debt once resolved');

  const listOpen = fx.run(['debt', 'list']);
  console.log('--- hedgehog debt list (open only) ---');
  console.log(listOpen);
  assertNotIncludes(listOpen, NOTE, 'default `debt list` excludes resolved debt');

  const listAll = fx.run(['debt', 'list', '--all']);
  console.log('--- hedgehog debt list --all ---');
  console.log(listAll);
  assertIncludes(listAll, NOTE, '`debt list --all` still shows the resolved note');
  assertIncludes(listAll, 'resolved', '`debt list --all` shows the resolution');

  // A rebuild replays committed files from scratch — the resolution must
  // survive it, the same way the original debt note does.
  fx.run(['db', 'rebuild']);
  const afterRebuild = fx.run(['debt', 'list', '--all']);
  console.log('--- hedgehog debt list --all (after db rebuild) ---');
  console.log(afterRebuild);
  assertIncludes(afterRebuild, 'resolved', 'the resolution survives `hedgehog db rebuild`');
} finally {
  fx.cleanup();
}

report('debt-can-be-resolved');
