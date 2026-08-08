#!/usr/bin/env node --experimental-sqlite
// Runs every reproduction in this directory, each in its own process, and
// exits non-zero if any of them does. No test framework — the scripts are
// plain Node with plain assertions.
//
//   node --experimental-sqlite repro/run-all.mjs

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = readdirSync(here)
  .filter((f) => /^\d\d-.*\.mjs$/.test(f))
  .sort();

const failed = [];
for (const script of scripts) {
  const res = spawnSync(process.execPath, ['--experimental-sqlite', join(here, script)], {
    stdio: 'inherit',
  });
  if (res.status !== 0) failed.push(script);
}

console.log('─'.repeat(60));
if (failed.length > 0) {
  console.log(`${failed.length} of ${scripts.length} reproduction(s) failed:`);
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`all ${scripts.length} reproduction(s) passed`);
