#!/usr/bin/env node
// Repro: when `hedgehog verify` closes the LAST layer of an intent, it
// must print the intent's goal and outcome back out, framed as a check —
// the one point in the circuit where what was built can be compared
// against what was asked for.
//
// Before the fix, closing the last layer printed only:
//   intent complete   every task for this intent is done
// — no restatement, so nothing anywhere compared the built work against
// the intent.

import { makeFixture, writeInScope, GOAL, OUTCOME, assertIncludes, report } from './lib.mjs';

const fx = makeFixture();
try {
  // Layer 1 of 2 — closing it must NOT print the check.
  fx.run(['claim', '--owner', 'repro']);
  writeInScope(fx.dir, 'src/card/model/card.js', 'export const Card = {};\n');
  const first = fx.run(['verify', 'CARD-DOMAIN-MODEL', '--owner', 'repro']);
  console.log('--- verify (first layer, intent still open) ---');
  console.log(first);
  if (first.includes('INTENT CHECK')) {
    console.error('  FAIL  the check printed while the intent was still open');
    process.exit(1);
  }
  console.log('  ok    no intent check while the intent is still open');

  // Layer 2 of 2 — closing it completes the intent.
  fx.run(['claim', '--owner', 'repro']);
  writeInScope(fx.dir, 'src/card/service/card-service.js', 'export const createCard = () => {};\n');
  const last = fx.run(['verify', 'CARD-DOMAIN-SERVICE', '--owner', 'repro']);
  console.log('--- verify (last layer, intent completes) ---');
  console.log(last);

  assertIncludes(last, 'INTENT CHECK', 'closing the last layer frames the restatement as a check');
  assertIncludes(last, GOAL, 'closing the last layer restates the intent goal');
  assertIncludes(last, OUTCOME, 'closing the last layer restates the intent outcome');
} finally {
  fx.cleanup();
}

report('intent-close-restates-goal');
