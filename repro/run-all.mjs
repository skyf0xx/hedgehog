#!/usr/bin/env node
// Runs every repro script in this directory, serially, and exits
// non-zero if any of them fails.
//
//   node repro/run-all.mjs
//
// Each script builds a throwaway project in a temp dir and drives the
// real `bin/cli.mjs`. Nothing here touches the repo working tree.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs' && f !== 'lib.mjs')
  .sort();

let failed = 0;
for (const script of scripts) {
  console.log(`\n${script}`);
  const r = spawnSync(process.execPath, [join(here, script)], {
    stdio: 'inherit',
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (r.status !== 0) failed++;
}

console.log(
  `\n${scripts.length - failed}/${scripts.length} repro script(s) passed`,
);
process.exit(failed === 0 ? 0 : 1);
