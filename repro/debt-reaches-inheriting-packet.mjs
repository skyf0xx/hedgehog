#!/usr/bin/env node
// Repro: a task must be able to leave declared debt for the tasks that
// inherit from it, and that debt must land in the inheriting task's
// packet.
//
// Before the fix there was no mechanism at all: a layer that discovered a
// real limitation could only write a "KNOWN LIMITATION" comment into a
// source file, and the task that inherited the problem was never told —
// its packet said nothing.

import { makeFixture, writeInScope, assertIncludes, report } from './packet-lib.mjs';

const NOTE =
  'Card.updatedAt is set by the caller, not the model — the service layer must stamp it';

const fx = makeFixture();
try {
  // Build and close layer 1, declaring debt against it on the way out.
  fx.run(['claim', '--owner', 'repro']);
  writeInScope(fx.dir, 'src/card/model/card.js', 'export const Card = {};\n');

  let added;
  try {
    added = fx.run(['debt', 'add', 'CARD-DOMAIN-MODEL', NOTE]);
  } catch (err) {
    console.error('  FAIL  `hedgehog debt add` is not a command');
    console.error(`    expected: a command that records a note against a task`);
    console.error(`    actual  : ${(err.stdout ?? '') + (err.stderr ?? '') || err.message}`);
    process.exit(1);
  }
  console.log('--- hedgehog debt add ---');
  console.log(added);

  fx.run(['verify', 'CARD-DOMAIN-MODEL', '--owner', 'repro']);

  // Layer 2 depends on layer 1 — its packet must carry layer 1's debt.
  const next = fx.run(['next']);
  console.log('--- hedgehog next (inheriting task) ---');
  console.log(next);

  assertIncludes(next, 'INHERITED DEBT', 'the inheriting packet has a debt section');
  assertIncludes(next, NOTE, 'the inheriting packet carries the declared note');
  assertIncludes(next, 'CARD-DOMAIN-MODEL', 'the debt names the task that declared it');

  // The same debt must reach the packet `hedgehog claim` emits, since
  // that is the surface the loop actually dispatches from.
  const claimed = fx.run(['claim', '--owner', 'repro']);
  console.log('--- hedgehog claim (inheriting task) ---');
  console.log(claimed);
  assertIncludes(claimed, NOTE, 'claim: the inheriting packet carries the declared note');
} finally {
  fx.cleanup();
}

report('debt-reaches-inheriting-packet');
