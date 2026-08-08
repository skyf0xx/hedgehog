#!/usr/bin/env node
// Runs every `hedgehog boundary` reproduction and summarizes. Each repro
// is standalone — run one directly to see its full output.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPROS = [
  'boundary-at-boundary.mjs',
  'boundary-work-in-flight.mjs',
  'boundary-dirty-tree.mjs',
  'boundary-intent-incomplete.mjs',
];

const results = [];
for (const repro of REPROS) {
  console.log(`\n======== ${repro} ========`);
  try {
    const out = execFileSync(process.execPath, [join(__dirname, repro)], { encoding: 'utf8' });
    console.log(out);
    results.push({ repro, ok: true });
  } catch (err) {
    console.log(err.stdout ?? '');
    console.log(err.stderr ?? '');
    results.push({ repro, ok: false });
  }
}

console.log('\n======== summary ========');
for (const { repro, ok } of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${repro}`);
const failed = results.filter((r) => !r.ok).length;
console.log('');
process.exit(failed === 0 ? 0 : 1);
