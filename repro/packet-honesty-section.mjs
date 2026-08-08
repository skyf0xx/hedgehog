#!/usr/bin/env node
// Reproduction: every task packet carries a standing honesty
// requirement.
//
// The packet is the only thing a layer agent is guaranteed to read on
// every task. On a real 36-task build the defensive behaviour that
// caught silent failures — a stub that threw by name, a UI that said
// "unavailable" instead of showing a fabricated 0, an agent that
// reported an undecided requirement rather than inventing one — came
// from a human hand-writing that instruction into each dispatch. A
// packet generated from core.yaml carried nothing of the kind.
//
// Run: node repro/packet-honesty-section.mjs
// Exits non-zero if the HONESTY section is missing or altered.

import { makeFixture, runNext, cleanup, fail, pass } from './fixture.mjs';

const EXPECTED_SECTION = [
  'HONESTY',
  "  Build what this layer can; make what it can't obvious.",
  '  - A stub or placeholder throws a named error at first use — never',
  '    returns empty, null, or success from something unbuilt.',
  '  - A value that cannot be computed is surfaced as unavailable — never',
  '    replaced by 0, "", or a plausible default.',
  "  - A decision RELEVANT RULES doesn't make is reported, not invented.",
  '  - A scope that turns out to be wrong is reported, not widened.',
  '  Reporting one of these is a successful outcome. Papering over it is',
  '  the failure VERIFICATION cannot catch.',
].join('\n');

const dir = await makeFixture();
let out;
try {
  out = runNext(dir);
} finally {
  await cleanup(dir);
}

const honestyAt = out.indexOf('\nHONESTY\n');
const section = honestyAt === -1 ? null : out.slice(honestyAt + 1).trimEnd();

if (section === null) {
  fail('hedgehog next emits an HONESTY section', EXPECTED_SECTION, out);
} else if (section !== EXPECTED_SECTION) {
  fail('the HONESTY section reads exactly as designed', EXPECTED_SECTION, section);
} else {
  pass('hedgehog next emits the HONESTY section verbatim');
}

// The four cases are load-bearing individually — a section that keeps
// the heading but drops the "never fabricate a value" clause buys
// nothing. Named here so a partial regression reports which case went.
const CASES = {
  'noisy stub': 'throws a named error at first use',
  'no fabricated value': 'surfaced as unavailable',
  'no invented decision': 'is reported, not invented',
  'no widened scope': 'is reported, not widened',
};

for (const [name, phrase] of Object.entries(CASES)) {
  if (!out.includes(phrase)) {
    fail(
      `packet states the "${name}" case`,
      phrase,
      section === null ? '(no HONESTY section in the packet at all)' : section,
    );
  } else {
    pass(`packet states the "${name}" case`);
  }
}

// The section has to survive being skimmed. A packet is read on every
// task; a wall of prose is read on none of them.
const sectionLines = EXPECTED_SECTION.split('\n').length;
if (sectionLines > 12) {
  fail(
    'the HONESTY section stays short enough to be read',
    'at most 12 lines',
    `${sectionLines} lines`,
  );
} else {
  pass(`the HONESTY section is ${sectionLines} lines`);
}

if (process.exitCode) {
  console.error('Reproduction failed: the packet does not carry the honesty requirement.');
} else {
  console.log('\nAll assertions passed.');
}
