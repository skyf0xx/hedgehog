#!/usr/bin/env node
// Runs every repro in this directory, serially, and exits non-zero if any
// of them does.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && f !== 'lib.mjs' && f !== 'run-all.mjs')
  .sort();

let failed = 0;
for (const script of scripts) {
  const { status } = spawnSync('node', [join(here, script)], { stdio: 'inherit' });
  if (status !== 0) failed++;
}

console.log(`\n${scripts.length - failed}/${scripts.length} repro(s) passed`);
process.exit(failed === 0 ? 0 : 1);
