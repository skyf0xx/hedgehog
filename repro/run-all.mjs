// Runs every reproduction in this directory, in order, and exits
// non-zero if any of them fails.
//
//   node --experimental-sqlite repro/run-all.mjs

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// A reproduction is any .mjs in this directory that isn't a shared
// helper. Helpers are named by convention: `_`-prefixed, `lib.mjs` or
// `*-lib.mjs`, or one of the four standalone names below.
//
// The rule is "everything except helpers" rather than "everything
// matching a pattern" on purpose. This runner used to select on
// /^\d+-.*\.mjs$/, which ran 20 of the 51 reproductions here and skipped
// the other 31 in silence — every reproduction whose author gave it a
// descriptive name instead of a number. A denylist fails loudly (a new
// helper gets run as a reproduction and errors) where an allowlist fails
// silently (a new reproduction is never run at all), and silent omission
// is the failure mode worth designing against.
const HELPERS = new Set(['run.mjs', 'run-all.mjs', 'harness.mjs', 'fixture.mjs']);
const isHelper = (f) => f.startsWith('_') || /(^|-)lib\.mjs$/.test(f) || HELPERS.has(f);

const scripts = readdirSync(HERE)
  .filter((f) => f.endsWith('.mjs') && !isHelper(f))
  .sort();

const failed = [];
for (const script of scripts) {
  console.log(`\n=== ${script} ===`);
  const result = spawnSync(process.execPath, ['--experimental-sqlite', join(HERE, script)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failed.push(script);
}

console.log('');
if (failed.length > 0) {
  console.log(`${failed.length} of ${scripts.length} reproduction(s) failed:`);
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`all ${scripts.length} reproduction(s) passed`);
