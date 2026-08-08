#!/usr/bin/env node
// Runs every reproduction in this directory, in order, and exits
// non-zero if any of them fails.
//
// Run: node repro/run-all.mjs

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = ['plan-no-open.mjs', 'requires-missing-binary.mjs', 'core-without-requires.mjs'];

const failed = [];
for (const script of SCRIPTS) {
  const res = spawnSync(process.execPath, [join(HERE, script)], { stdio: 'inherit' });
  if (res.status !== 0) failed.push(script);
}

if (failed.length > 0) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('All reproductions passed.');
