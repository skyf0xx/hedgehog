#!/usr/bin/env node
// Runs every reproduction in order and exits non-zero if any failed.
//
//   node repro/run-all.mjs

import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = (await readdir(here))
  .filter((f) => /^\d+-.*\.mjs$/.test(f))
  .sort();

let failed = 0;
for (const script of scripts) {
  try {
    const out = execFileSync(process.execPath, [join(here, script)], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    process.stdout.write(out);
  } catch (err) {
    failed++;
    process.stdout.write(`${err.stdout ?? ''}`);
    process.stderr.write(`${err.stderr ?? ''}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${scripts.length} reproduction script(s) failed.`);
  process.exit(1);
}
console.log(`\nall ${scripts.length} reproduction script(s) passed.`);
