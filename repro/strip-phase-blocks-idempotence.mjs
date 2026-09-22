#!/usr/bin/env node
// Reproduction for stripPhaseBlocks (src/hosts/claude-md-merge.mjs).
//
// The identity case — unmarked content comes back byte-for-byte
// unchanged — is the one assertion that must never be skipped: every
// core package that hasn't adopted `bootstrap-only` markers yet relies
// on stripPhaseBlocks being a no-op on its own content.
//
// No test framework is available. Plain assertions, expected-vs-actual
// on failure, non-zero exit if anything fails.
//
// Run: node repro/strip-phase-blocks-idempotence.mjs

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripPhaseBlocks } from '../src/hosts/claude-md-merge.mjs';

let failures = 0;
let passes = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passes++;
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`          expected: ${JSON.stringify(expected)}`);
    console.log(`          actual:   ${JSON.stringify(actual)}`);
  }
}

function checkThrows(name, fn) {
  try {
    const value = fn();
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`          expected: a thrown error`);
    console.log(`          actual:   returned ${JSON.stringify(value)}`);
  } catch {
    passes++;
    console.log(`  PASS  ${name}`);
  }
}

// ---------------------------------------------------------------------
console.log('\n1. identity — no markers present, content unchanged');
{
  const samples = [
    'plain markdown\n\nwith a couple of paragraphs\n',
    '',
    '# Heading\n\n- a list\n- another item\n',
    'text mentioning "bootstrap" and "start" and "end" as ordinary words\n',
  ];
  for (const [i, sample] of samples.entries()) {
    check(`sample ${i + 1} returned byte-for-byte unchanged`, stripPhaseBlocks(sample, 'bootstrap-only'), sample);
  }
}

// ---------------------------------------------------------------------
console.log('\n2. a single marked block is removed with its surrounding blank lines');
{
  const content = [
    'A',
    '',
    '<!-- hedgehog:bootstrap-only start -->',
    'B',
    'line two',
    '<!-- hedgehog:bootstrap-only end -->',
    '',
    'C',
    '',
  ].join('\n');
  check('block and surrounding blank lines removed, no double blank line', stripPhaseBlocks(content, 'bootstrap-only'), 'A\n\nC\n');
}

// ---------------------------------------------------------------------
console.log('\n3. idempotence — stripping twice equals stripping once');
{
  const content = [
    'X',
    '<!-- hedgehog:bootstrap-only start -->',
    'Y',
    '<!-- hedgehog:bootstrap-only end -->',
    'Z',
    '<!-- hedgehog:bootstrap-only start -->',
    'W',
    '<!-- hedgehog:bootstrap-only end -->',
    'V',
    '',
  ].join('\n');
  const once = stripPhaseBlocks(content, 'bootstrap-only');
  const twice = stripPhaseBlocks(once, 'bootstrap-only');
  check('second strip is a no-op', twice, once);
}

// ---------------------------------------------------------------------
console.log('\n4. malformed markers are errors, never a silent partial strip');
{
  checkThrows('unterminated start marker throws', () =>
    stripPhaseBlocks('<!-- hedgehog:bootstrap-only start -->\nunterminated\n', 'bootstrap-only'));
  checkThrows('orphaned end marker throws', () =>
    stripPhaseBlocks('orphaned\n<!-- hedgehog:bootstrap-only end -->\n', 'bootstrap-only'));
  checkThrows('mismatched marker count throws', () =>
    stripPhaseBlocks(
      [
        '<!-- hedgehog:bootstrap-only start -->',
        'one',
        '<!-- hedgehog:bootstrap-only end -->',
        '<!-- hedgehog:bootstrap-only start -->',
        'two, never closed',
      ].join('\n'),
      'bootstrap-only',
    ));
}

// ---------------------------------------------------------------------
console.log('\n5. identity against every cached core template on this machine');
// A local, machine-specific cache (~/.hedgehog/cores/*/*/CLAUDE.core.md)
// rather than a repo fixture, so this is a bonus pass when present and a
// silent skip otherwise — CI never has it, and that must not read as a
// failure.
{
  const coresDir = join(homedir(), '.hedgehog/cores');
  let coreNames = [];
  try {
    coreNames = (await readdir(coresDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    console.log('  SKIP  no ~/.hedgehog/cores/ cache on this machine');
  }
  let templatesChecked = 0;
  for (const name of coreNames) {
    const versionsDir = join(coresDir, name);
    let versions;
    try {
      versions = (await readdir(versionsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const version of versions) {
      const templatePath = join(versionsDir, version, 'CLAUDE.core.md');
      const text = await readFile(templatePath, 'utf8').catch(() => null);
      if (text === null) continue;
      templatesChecked++;
      check(
        `${name}@${version} CLAUDE.core.md unchanged when no markers`,
        stripPhaseBlocks(text, 'bootstrap-only'),
        text,
      );
    }
  }
  if (coreNames.length > 0 && templatesChecked === 0) {
    console.log('  SKIP  cache present but no CLAUDE.core.md found in it');
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
