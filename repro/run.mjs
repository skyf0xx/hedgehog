#!/usr/bin/env node
// Runs every reproduction in its own child process — each one chdirs
// into its own temp directory, so they can't share one. Exits non-zero
// if any reproduction fails.
//
//   node repro/run.mjs

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const NOT_A_REPRO = new Set(['run.mjs', 'harness.mjs']);

const REPROS = readdirSync(here)
  .filter((name) => name.endsWith('.mjs') && !NOT_A_REPRO.has(name))
  .sort();

let failed = 0;
for (const name of REPROS) {
  console.log(`${'='.repeat(72)}\n${name}\n${'='.repeat(72)}`);
  const res = spawnSync(process.execPath, [join(here, name)], {
    cwd: root,
    stdio: 'inherit',
  });
  if (res.status !== 0) failed++;
  console.log('');
}

console.log('='.repeat(72));
if (failed === 0) {
  console.log(`all ${REPROS.length} reproductions passed`);
  process.exit(0);
}
console.log(`${failed} of ${REPROS.length} reproductions FAILED`);
process.exit(1);
