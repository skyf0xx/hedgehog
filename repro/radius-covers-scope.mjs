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
import { loadCore, lintCore } from '../src/db/core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

// Containment between two globs, in the dialect verify.mjs enforces scope
// with (git pathspec `:(glob)`): `*`/`?` stay inside one segment, `**`
// spans any number. A segment-prefix comparison — the scheduler's own
// globsOverlap algebra — answers "could these two globs ever meet", which
// is NOT containment: every `reject` row below shares a literal prefix
// with its scope glob while matching none, some, or the wrong part of it.
//
// `accept` rows must load: a wrong hard failure is worse than a missing
// one, since it breaks every command on a legitimate core.
const CONTAINMENT = {
  reject: [
    // The reviewer's case: a single-segment wildcard cannot reach a
    // deeper path, however much literal prefix it shares.
    { scope: ['a/b/**'], radius: ['a/*.ts'], why: 'a/*.ts matches nothing under a/b/' },
    { scope: ['a/b/**'], radius: ['a/*'], why: 'a/* is one segment deep, a/b/** is deeper' },
    { scope: ['apps/api/src/**'], radius: ['apps/api/*.ts'], why: 'sibling files, not the tree' },
    { scope: ['a/b/c.ts'], radius: ['a/*/d.ts'], why: 'literal segment mismatch under the wildcard' },
    { scope: ['a/**'], radius: ['a/b/**'], why: 'radius is the narrower subtree' },
    { scope: ['a/b/**'], radius: ['a/b'], why: 'a bare directory path is not its subtree' },
  ],
  accept: [
    { scope: ['a/b/**'], radius: ['a/**'], why: 'trailing ** covers everything below' },
    { scope: ['a/b/**'], radius: ['a/b/**'], why: 'identical' },
    { scope: ['a/b/c.ts'], radius: ['a/*/c.ts'], why: 'wildcard segment matches the literal' },
    { scope: ['a/b/c.ts'], radius: ['a/b/*.ts'], why: 'in-segment wildcard matches the file' },
    { scope: ['a/{module}/**'], radius: ['a/**'], why: 'module placeholder is a literal segment' },
    // Shapes the shipped and real authored cores actually use.
    { scope: ['packages/db/src/schema/{module}/**'], radius: ['packages/db/**'], why: 'full-stack-app schema' },
    { scope: ['packages/hooks/src/{module}/**'], radius: ['packages/hooks/**'], why: 'full-stack-app hook' },
    { scope: ['apps/api/src/{module}/http/**', 'apps/api/src/app.module.ts'], radius: ['apps/api/**'], why: 'authored api layer' },
    // The union covers it even though no single glob does — must not be
    // a hard failure, because rejecting it would be rejecting a core that
    // is actually fine.
    { scope: ['a/b/**'], radius: ['a/b/*', 'a/b/*/**'], why: 'covered by the union' },
  ],
};

function containmentYaml(scope, radius) {
  return `
id: repro-containment
layers:
  - id: only
    scope: [${scope.map((g) => `"${g}"`).join(', ')}]
    verify: "pnpm test"
    verify_radius: [${radius.map((g) => `"${g}"`).join(', ')}]
    commit: "feat: only"
`;
}

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

  // ── 4. Containment, both directions. A radius sharing a literal
  //    prefix with the scope is not thereby covering it; and a radius
  //    that genuinely covers must still load. ─────────────────────────
  let caseIndex = 0;
  for (const { scope, radius, why } of CONTAINMENT.reject) {
    const result = await loadYaml(dir, `reject-${caseIndex++}`, containmentYaml(scope, radius));
    if (result.ok) {
      failures.push(
        `containment/reject: scope ${JSON.stringify(scope)} radius ${JSON.stringify(radius)} (${why})\n` +
          '      expected: loadCore throws — the radius does not cover the scope\n' +
          '      actual:   loaded clean',
      );
    }
  }
  for (const { scope, radius, why } of CONTAINMENT.accept) {
    const result = await loadYaml(dir, `accept-${caseIndex++}`, containmentYaml(scope, radius));
    if (!result.ok) {
      failures.push(
        `containment/accept: scope ${JSON.stringify(scope)} radius ${JSON.stringify(radius)} (${why})\n` +
          '      expected: loads clean — rejecting this would hard-fail a legitimate core\n' +
          `      actual:   rejected — ${result.message}`,
      );
    }
  }

  // ── 5. What can be neither proven nor disproven degrades to a
  //    warning, not a throw — the union case loads, and says so. ──────
  {
    const union = await loadYaml(
      dir,
      'union',
      containmentYaml(['a/b/**'], ['a/b/*', 'a/b/*/**']),
    );
    if (union.ok) {
      const warnings = lintCore(union.core).filter((w) => w.includes('cannot prove'));
      if (warnings.length !== 1) {
        failures.push(
          'unprovable containment: scope ["a/b/**"] radius ["a/b/*", "a/b/*/**"]\n' +
            '      expected: 1 "cannot prove" warning — loaded, but flagged for the author\n' +
            `      actual:   ${warnings.length} — ${JSON.stringify(lintCore(union.core), null, 2)}`,
        );
      }
    }
  }

  // ── 6. No false alarm: both shipped cores still load, and neither
  //    trips the "cannot prove" warning. ──────────────────────────────
  for (const core of ['full-stack-app', 'landing-page']) {
    const path = join(ROOT, 'repro/fixtures/cores', `${core}.core.yaml`);
    try {
      const loaded = await loadCore(path);
      const unprovable = lintCore(loaded).filter((w) => w.includes('cannot prove'));
      if (unprovable.length > 0) {
        failures.push(
          `shipped core "${core}"\n` +
            '      expected: every radius provably covers its scope\n' +
            `      actual:   ${unprovable.join(' | ')}`,
        );
      }
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
console.log(
  `radius-covers-scope: ok — narrow/empty radii rejected, ${CONTAINMENT.reject.length} non-covering radii rejected, ` +
    `${CONTAINMENT.accept.length} covering radii accepted, unprovable containment warned not thrown, both shipped cores clean`,
);
