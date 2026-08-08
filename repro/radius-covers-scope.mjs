#!/usr/bin/env node
// Repro: a layer may declare a `verify_radius` that does not contain its
// own `scope`, and the loader accepts it.
//
// Why that is wrong, in the scheduler's own terms: src/db/conflict.mjs's
// conflicts() compares scope against scope, then radius against radius.
// Nothing compares one task's scope against another task's radius, and
// verifyRadius() returns the declared radius ALONE when set (it is not
// unioned with scope). So "task A writes a file task B's verify reads" is
// only ever detected because every layer's radius contains its own scope.
// A radius that drops part of its scope silently deletes that detection
// and the two tasks co-schedule.
//
// Expected after the fix: loadCore/validateCore rejects it, both shipped
// cores still load, and a radius that does contain its scope still loads.
//
// No build graph, no sqlite — this is a core-definition-level defect.
// Run: node repro/radius-covers-scope.mjs

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from '../src/db/core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const NARROW_RADIUS = `
id: repro-narrow-radius
layers:
  - id: api
    scope: ["apps/api/src/{module}/**", "apps/api/src/app.module.ts"]
    verify: "pnpm --filter api exec vitest run"
    verify_radius: ["apps/api/src/{module}/**"]
    commit: "feat({module}): api"
`;

const EMPTY_RADIUS = `
id: repro-empty-radius
layers:
  - id: api
    scope: ["apps/api/src/{module}/**"]
    verify: "pnpm --filter api exec vitest run"
    verify_radius: []
    commit: "feat({module}): api"
`;

const GOOD_RADIUS = `
id: repro-good-radius
layers:
  - id: api
    scope: ["apps/api/src/{module}/**", "apps/api/src/app.module.ts"]
    verify: "pnpm --filter api exec vitest run"
    verify_radius: ["apps/api/**"]
    commit: "feat({module}): api"
`;

async function loadYaml(dir, name, text) {
  const path = join(dir, `${name}.yaml`);
  await writeFile(path, text, 'utf8');
  try {
    return { ok: true, core: await loadCore(path) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

const dir = await mkdtemp(join(tmpdir(), 'hedgehog-radius-'));
try {
  // ── 1. A radius that omits part of its own scope must be rejected. ──
  const narrow = await loadYaml(dir, 'narrow', NARROW_RADIUS);
  if (narrow.ok) {
    failures.push(
      'repro-narrow-radius: scope ["apps/api/src/{module}/**", "apps/api/src/app.module.ts"] ' +
        'with verify_radius ["apps/api/src/{module}/**"]\n' +
        '      expected: loadCore throws — "apps/api/src/app.module.ts" is written inside scope but sits outside the declared radius\n' +
        '      actual:   loaded clean, verify_radius = ' +
        JSON.stringify(narrow.core.layers[0].verify_radius),
    );
  } else if (!/verify_radius/.test(narrow.message) || !/app\.module\.ts/.test(narrow.message)) {
    failures.push(
      'repro-narrow-radius: rejected, but the message names neither verify_radius nor the uncovered glob\n' +
        `      actual:   ${narrow.message}`,
    );
  }

  // ── 2. An empty declared radius covers nothing, so it is the same
  //    defect in its most extreme form (and is NOT the same thing as
  //    omitting the field, which falls back to scope). ────────────────
  const empty = await loadYaml(dir, 'empty', EMPTY_RADIUS);
  if (empty.ok) {
    failures.push(
      'repro-empty-radius: verify_radius []\n' +
        '      expected: loadCore throws — an empty radius conflicts with nothing on the verify axis\n' +
        '      actual:   loaded clean, verify_radius = ' +
        JSON.stringify(empty.core.layers[0].verify_radius),
    );
  }

  // ── 3. No false alarm: a radius that does contain its scope loads. ──
  const good = await loadYaml(dir, 'good', GOOD_RADIUS);
  if (!good.ok) {
    failures.push(
      'repro-good-radius: scope under verify_radius ["apps/api/**"]\n' +
        '      expected: loads clean\n' +
        `      actual:   rejected — ${good.message}`,
    );
  }

  // ── 4. No false alarm: both shipped cores still load. ───────────────
  for (const core of ['full-stack-app', 'landing-page']) {
    const path = join(ROOT, 'src/golden-cores', core, 'core.yaml');
    try {
      await loadCore(path);
    } catch (err) {
      failures.push(
        `shipped core "${core}"\n` +
          '      expected: loads clean\n' +
          `      actual:   rejected — ${err.message}`,
      );
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nradius-covers-scope: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('radius-covers-scope: ok — narrow and empty radii rejected, good radius and both shipped cores load clean');
