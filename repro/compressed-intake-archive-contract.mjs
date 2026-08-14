// Reproduction: compressed intake's archive must satisfy every downstream
// step that reads `.hedgehog/BMAD/`.
//
// The failure mode this pins is subtle because it is a documentation
// contract, not a code path: compressed intake is described in one file
// (`hedgehog-planning-intake`) and consumed in several others, so the two
// can drift apart silently. Nothing executes these files — a consumer
// left naming a source the mode never writes fails only on a real run, at
// the point an agent has to improvise, which is the exact outcome the
// mode exists to prevent.
//
// Three properties, one per way the drift shows up:
//
//   A. Every file compressed intake writes is a file some consumer reads,
//      and every consumer's documented source is a file it writes. A
//      consumer naming `02-brief.md` as its only source would strand a
//      compressed run.
//
//   B. The mode is recorded in the archive, not inferred from absence.
//      `00-manifest.md` carries it, so `.hedgehog/BMAD/` exists after
//      intake whichever mode ran.
//
//   C. The Add-ons gate survives the compression, and landing-page is
//      excluded — the two constraints the mode is most likely to lose if
//      someone later "simplifies" it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkContains, check, report, REPO_ROOT } from './_lib.mjs';

// These files are hard-wrapped prose, so a phrase this repro asserts on
// can be split across a line break at any time by an unrelated edit.
// Collapsing whitespace makes the assertions test the wording rather than
// the wrapping — the wrapping is not the contract.
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8').replace(/\s+/g, ' ');

const INTAKE = read('src/skills/hedgehog-planning-intake/SKILL.md');
const PLANNER = read('src/agents/planner.md');
const UX_PLANNER = read('src/agents/ux-planner.md');
const CORE_DESIGN = read('src/skills/hedgehog-core-design/SKILL.md');

console.log('repro: compressed intake writes what its consumers read\n');

// --- A. the archive covers every consumer's documented source ---------

// The section that defines the mode. Scoping the assertions to it keeps a
// stray mention elsewhere in the file from satisfying them.
const START = INTAKE.indexOf('### Compressed intake');
const END = INTAKE.indexOf('## Phase 1 — Mining');
const COMPRESSED = START === -1 || END === -1 ? '' : INTAKE.slice(START, END);

check('A0. the compressed-intake section exists and precedes Phase 1', true, COMPRESSED.length > 0);

// Phase 1's mining reads 04-prd.md §3 and §4. Compressed intake has to
// write exactly that, or mining has no source.
checkContains('A1. compressed intake writes 04-prd.md', COMPRESSED, '04-prd.md');
checkContains('A2. it writes the two sections mining reads', COMPRESSED, '§3 Glossary and §4 Features');

// ux-planner's documented source is 05-ux-spec/. The mode writes the
// EXPERIENCE half and states that DESIGN is absent by design.
checkContains('A3. compressed intake writes 05-ux-spec/EXPERIENCE.md', COMPRESSED, 'EXPERIENCE.md');
checkContains('A4. it states DESIGN.md is not written', COMPRESSED, '`DESIGN.md`');

// The consumer side: ux-planner must not require both halves, and must
// treat an absent file as a cue to ask rather than to infer.
checkContains(
  'A5. ux-planner reads whichever half the archive holds',
  UX_PLANNER,
  'whichever of the two the archive holds',
);
checkContains('A6. an absent UX spec makes ux-planner ask, not invent', UX_PLANNER, 'cue to ask, not to invent');

// Re-entry names 02-brief.md, which a compressed archive never has, so it
// has to say what it reads instead.
checkContains('A7. Re-entry states what it reads on a compressed archive', INTAKE, 'on a compressed archive that\'s `04-prd.md`');

// core-design reads the archive to choose a stack on an authored core.
checkContains('A8. core-design checks the manifest for what the archive holds', CORE_DESIGN, '00-manifest.md');
checkContains(
  'A9. core-design surfaces the thinner input at Confirm & Lock',
  CORE_DESIGN,
  'compressed intake',
);

// --- B. the mode is recorded, never inferred from a missing directory --

checkContains('B1. the manifest records which mode ran', INTAKE, 'which intake mode ran');
checkContains('B2. the manifest states mode: compressed', COMPRESSED, 'mode: compressed');
checkContains(
  'B3. an absent archive means intake never ran',
  COMPRESSED,
  'means intake never ran',
);

// --- C. the gates that must survive the compression -------------------

checkContains('C1. the Add-ons decision is still answered, never guessed', COMPRESSED, 'must each be *answered*');
checkContains('C2. planner ties the batched round to the Add-ons gate', PLANNER, 'holds identically on compressed intake');
checkContains('C3. landing-page is excluded from the mode', COMPRESSED, 'Not available on landing-page');
checkContains(
  'C4. the mode is chosen by the user, never recommended',
  COMPRESSED,
  'never the default',
);
checkContains(
  'C5. planner still surfaces the conflict before the mode is reachable',
  PLANNER,
  'Surface the conflict first',
);

report('compressed intake — archive satisfies every documented consumer');
