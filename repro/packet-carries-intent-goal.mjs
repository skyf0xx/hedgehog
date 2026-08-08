#!/usr/bin/env node
// Repro: the task packet an agent actually receives must carry the
// intent's GOAL and OUTCOME.
//
// Two surfaces emit a packet:
//   * `hedgehog next` — prints the formatted packet.
//   * `hedgehog claim` — the surface the loop skills and CLAUDE.md tell
//     agents to use ("returns up to N task packets, STATUS/INTENT/
//     RELEVANT RULES/WHY NOW/BLOCKED DOWNSTREAM/ALLOWED SCOPE/
//     VERIFICATION each").
//
// Before the fix: `next` printed the goal and outcome as two unlabeled
// lines under INTENT, and `claim` printed no packet at all — only the
// task id and the lease expiry. An agent following the documented loop
// therefore never saw what the intent asked for.

import { makeFixture, GOAL, OUTCOME, assertIncludes, report } from './lib.mjs';

const fx = makeFixture();
try {
  const next = fx.run(['next']);
  console.log('--- hedgehog next ---');
  console.log(next);

  assertIncludes(next, GOAL, 'next: packet carries the intent goal');
  assertIncludes(next, OUTCOME, 'next: packet carries the intent outcome');
  assertIncludes(next, 'GOAL', 'next: the goal is labelled, not a bare line');
  assertIncludes(next, 'OUTCOME', 'next: the outcome is labelled, not a bare line');

  const claimed = fx.run(['claim', '--owner', 'repro']);
  console.log('--- hedgehog claim ---');
  console.log(claimed);

  assertIncludes(claimed, GOAL, 'claim: packet carries the intent goal');
  assertIncludes(claimed, OUTCOME, 'claim: packet carries the intent outcome');
  assertIncludes(claimed, 'ALLOWED SCOPE', 'claim: emits the full packet, not just a lease line');
  assertIncludes(claimed, 'VERIFICATION', 'claim: emits the packet VERIFICATION section');
} finally {
  fx.cleanup();
}

report('packet-carries-intent-goal');
