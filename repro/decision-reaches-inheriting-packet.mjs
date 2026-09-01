#!/usr/bin/env node
// Repro: a task must be able to leave a declared decision for the tasks
// that inherit from it, and that decision must land in the inheriting
// task's packet — the same delivery mechanism as debt, but for *why* a
// task was built the way it was rather than what's still wrong with it.
//
// Before this, only debt existed: a task that chose a pattern, a library,
// or a trade-off had no way to tell the tasks that inherit from it *why*
// — only a known limitation had a mechanism. A dependent task built by a
// different, isolated agent session had no way to learn the reasoning
// behind a related task's choice beyond reading its diff and guessing.

import { makeFixture, writeInScope, assertIncludes, report } from './packet-lib.mjs';

const NOTE =
  'Card is a plain object, not a class — the domain has no behavior of its own yet, so a class would just be ceremony';

const fx = makeFixture();
try {
  // Build and close layer 1, declaring a decision against it on the way out.
  fx.run(['claim', '--owner', 'repro']);
  writeInScope(fx.dir, 'src/card/model/card.js', 'export const Card = {};\n');

  let added;
  try {
    added = fx.run(['decision', 'add', 'CARD-DOMAIN-MODEL', NOTE]);
  } catch (err) {
    console.error('  FAIL  `hedgehog decision add` is not a command');
    console.error(`    expected: a command that records a note against a task`);
    console.error(`    actual  : ${(err.stdout ?? '') + (err.stderr ?? '') || err.message}`);
    process.exit(1);
  }
  console.log('--- hedgehog decision add ---');
  console.log(added);

  fx.run(['verify', 'CARD-DOMAIN-MODEL', '--owner', 'repro']);

  // Layer 2 depends on layer 1 — its packet must carry layer 1's decision.
  const next = fx.run(['next']);
  console.log('--- hedgehog next (inheriting task) ---');
  console.log(next);

  assertIncludes(next, 'INHERITED DECISIONS', 'the inheriting packet has a decisions section');
  assertIncludes(next, NOTE, 'the inheriting packet carries the declared note');
  assertIncludes(next, 'CARD-DOMAIN-MODEL', 'the decision names the task that declared it');

  // The same decision must reach the packet `hedgehog claim` emits, since
  // that is the surface the loop actually dispatches from.
  const claimed = fx.run(['claim', '--owner', 'repro']);
  console.log('--- hedgehog claim (inheriting task) ---');
  console.log(claimed);
  assertIncludes(claimed, NOTE, 'claim: the inheriting packet carries the declared note');

  // hedgehog decision list must report it back, the same way debt list does.
  const listed = fx.run(['decision', 'list']);
  console.log('--- hedgehog decision list ---');
  console.log(listed);
  assertIncludes(listed, NOTE, 'decision list reports the declared note');
  assertIncludes(listed, 'CARD-DOMAIN-MODEL', 'decision list names the declaring task');
} finally {
  fx.cleanup();
}

report('decision-reaches-inheriting-packet');
