#!/usr/bin/env node
// No-regression harness for the quoted-scalar escape fix.
//
// Loads every ordinary core definition this repo keeps through the real
// loader and prints a stable, fully-ordered dump of the parsed result.
// Run it before and after a change to src/db/core.mjs and diff the two
// outputs: identical output means ordinary core definitions parse exactly
// as they did.
//
// The definitions live in repro/fixtures/cores/ as `<core>.core.yaml`,
// vendored from the cores that ship them so this harness has real
// material to parse without depending on a core package being fetched.
//
// Run: node repro/parse-real-cores.mjs

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore, parseCoreYaml } from '../src/db/core.mjs';
import { readFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(root, 'repro/fixtures/cores');

function findCoreYaml(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findCoreYaml(full, found);
    else if (entry === 'core.yaml' || entry.endsWith('.core.yaml')) found.push(full);
  }
  return found;
}

const files = findCoreYaml(FIXTURES).sort();
if (files.length === 0) {
  console.error(`no core definition found under ${relative(root, FIXTURES)} — the harness would prove nothing`);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const rel = relative(root, file);
  console.log(`=== ${rel} ===`);
  try {
    // loadCore = parseCoreYaml + validateCore, the real entry point.
    const core = await loadCore(file);
    // Re-parse the raw text too, so a validation-only difference cannot
    // hide a parse difference.
    const raw = parseCoreYaml(await readFile(file, 'utf8'));
    if (JSON.stringify(core) !== JSON.stringify(raw)) {
      console.log('  !! loadCore and parseCoreYaml disagree');
      failed++;
    }
    console.log(JSON.stringify(core, null, 2));
  } catch (error) {
    console.log(`  !! FAILED TO LOAD: ${error.message}`);
    failed++;
  }
}

console.log(`\n${files.length} core file(s), ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
