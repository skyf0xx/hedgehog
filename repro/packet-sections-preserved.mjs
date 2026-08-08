#!/usr/bin/env node
// Reproduction: adding the HONESTY section changes nothing else about
// the packet.
//
// The packet is a contract with every agent definition, skill, and host
// dispatch file that names its sections (src/agents/layer-eng.md,
// src/skills/hedgehog-authored-loop/SKILL.md, src/hosts/routing.mjs, …).
// This asserts the pre-existing packet is byte-identical to what it was
// before, in the same order, and that the new section is strictly
// appended after VERIFICATION rather than inserted among them.
//
// Run: node repro/packet-sections-preserved.mjs
// Exits non-zero if any pre-existing line, section, or ordering moved.

import { makeFixture, runNext, cleanup, fail, pass } from './fixture.mjs';

// The exact `hedgehog next` output for this fixture at v4.0.3, before
// the honesty section existed. Recorded literally: this is the text that
// must not move.
const BASELINE = `TASK  BILLING-SCHEMA
schema for billing

STATUS   READY

INTENT
  Charge a customer for a subscription period
  An invoice exists for every closed period

RELEVANT RULES
  - An invoice is immutable once issued
  - A period with no usage still produces an invoice

WHY NOW
  ✓ Intent "billing" compiled into the graph
  ✓ Domain module "billing" resolved
  ✓ No incomplete dependencies

BLOCKED DOWNSTREAM
  ✗ BILLING-SERVICE   service

ALLOWED SCOPE
  src/schema/**

VERIFICATION
  node --version`;

const SECTION_ORDER = [
  'STATUS',
  'INTENT',
  'RELEVANT RULES',
  'WHY NOW',
  'BLOCKED DOWNSTREAM',
  'ALLOWED SCOPE',
  'VERIFICATION',
  'HONESTY',
];

const dir = await makeFixture();
let out;
try {
  out = runNext(dir);
} finally {
  await cleanup(dir);
}

// 1. Every pre-existing byte is still there, unchanged, as one
//    contiguous block starting at the top of the packet.
if (!out.startsWith(BASELINE)) {
  const actual = out.slice(0, BASELINE.length);
  fail('the pre-existing packet is unchanged and still leads the output', BASELINE, actual);
} else {
  pass('the pre-existing packet is unchanged and still leads the output');
}

// 2. Section headings appear once each, in this order. Headings are
//    column-0 lines; every body line in the packet is indented. The
//    first two lines are the task id and its objective, not a section.
const headings = out
  .split('\n')
  .slice(2)
  .filter((l) => l.length > 0 && l === l.trimStart())
  .map((l) => l.split(/\s{2,}/)[0]);

if (headings.join(' | ') !== SECTION_ORDER.join(' | ')) {
  fail('packet sections appear once each, in order', SECTION_ORDER.join(' | '), headings.join(' | '));
} else {
  pass(`packet sections in order: ${headings.join(' → ')}`);
}

// 3. The new section is appended, not interleaved — nothing pre-existing
//    is pushed below it.
const honestyAt = out.indexOf('\nHONESTY\n');
const verificationAt = out.indexOf('\nVERIFICATION\n');
if (honestyAt === -1) {
  fail('HONESTY is appended after VERIFICATION', 'an HONESTY section after VERIFICATION', out);
} else if (honestyAt < verificationAt) {
  fail(
    'HONESTY is appended after VERIFICATION',
    'HONESTY after VERIFICATION',
    `HONESTY at ${honestyAt}, VERIFICATION at ${verificationAt}`,
  );
} else {
  pass('HONESTY is appended after VERIFICATION');
}

if (process.exitCode) {
  console.error('Reproduction failed: the packet is not the old packet plus one section.');
} else {
  console.log('\nAll assertions passed.');
}
