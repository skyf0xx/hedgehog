#!/usr/bin/env node
// Repro: a layer's verify command can be narrower than the verify_radius
// it declares, and nothing says so.
//
// The radius is the layer's claim that its verify run READS that whole
// set; src/db/conflict.mjs serializes other tasks against exactly that
// claim. When the command's only path arguments sit inside the layer's
// own `scope`, the command is anchored to the scope directory: everything
// between scope and the radius is never executed, and a task that breaks
// a neighbour inside its own declared radius commits green. Observed for
// real — an `api` layer scoped to `apps/api/src/{module}/http/**` with
// `verify_radius: ["apps/api/**"]` and `vitest run src/{module}/http/`
// bound an adapter to a port and invalidated another module's spec
// asserting the port was still unbound. tsc saw no type error, the spec
// never ran.
//
// Distinct from the Step 5 filter-token rule (upstream #5), which
// cross-checks verify's filter tokens against the layer's own SCOPE. A
// command can satisfy that perfectly — case B below does — and still
// leave its declared radius unexercised.
//
// Expected after the fix: lintCore() warns on the anchored-command case,
// stays silent where it has no evidence, and reports nothing on either
// shipped core.
//
// No build graph, no sqlite — this is a core-definition-level defect.
// Run: node repro/verify-covers-radius.mjs

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore, parseCoreYaml } from '../src/db/core.mjs';
import * as coreModule from '../src/db/core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

if (typeof coreModule.lintCore !== 'function') {
  console.error('\nverify-covers-radius: 1 failure\n');
  console.error(
    '  ✗ src/db/core.mjs\n' +
      '      expected: an exported lintCore(core) reporting a verify command narrower than its declared verify_radius\n' +
      `      actual:   no such export (exports: ${Object.keys(coreModule).join(', ')})\n`,
  );
  process.exit(1);
}
const { lintCore } = coreModule;

// A — the observed defect: radius is the whole app, the command's only
//     path argument is the layer's own scope directory.
const ANCHORED = `
id: repro-anchored
layers:
  - id: domain-service
    scope: ["apps/api/src/{module}/domain/**"]
    verify: "pnpm --filter api exec tsc -p tsconfig.json --noEmit && pnpm --filter api exec vitest run src/{module}/domain/"
    verify_radius: ["apps/api/**"]
    commit: "feat({module}): domain-service"
  - id: api
    depends_on: domain-service
    scope: ["apps/api/src/{module}/http/**"]
    verify: "pnpm --filter api exec tsc -p tsconfig.json --noEmit && pnpm --filter api exec vitest run src/{module}/http/"
    verify_radius: ["apps/api/**"]
    commit: "feat({module}): api"
`;

// B — the fix: same radius, command runs the whole app's suite. Note it
//     still satisfies the Step 5 filter-token rule; the two axes differ.
const WHOLE_SUITE = `
id: repro-whole-suite
layers:
  - id: api
    scope: ["apps/api/src/{module}/http/**"]
    verify: "pnpm --filter api exec tsc -p tsconfig.json --noEmit && pnpm --filter api exec vitest run"
    verify_radius: ["apps/api/**"]
    commit: "feat({module}): api"
`;

// C — also correct: the command's path argument is an ANCESTOR of scope,
//     so it reaches the radius rather than being pinned inside scope.
const ANCESTOR_PATH = `
id: repro-ancestor
layers:
  - id: api
    scope: ["apps/api/src/{module}/http/**"]
    verify: "pnpm --filter api exec vitest run src/"
    verify_radius: ["apps/api/**"]
    commit: "feat({module}): api"
`;

// D — no radius declared at all: radius defaults to scope, so there is no
//     gap between them and nothing to warn about, however narrow the
//     command's path argument is.
const NO_RADIUS = `
id: repro-no-radius
layers:
  - id: api
    scope: ["apps/api/src/{module}/http/**"]
    verify: "pnpm --filter api exec vitest run src/{module}/http/"
    commit: "feat({module}): api"
`;

function warn(text) {
  return lintCore(parseCoreYaml(text));
}

// ── 1. The defect is reported, once per affected layer, naming the
//    neighbouring layer whose scope the radius covers. ────────────────
{
  const warnings = warn(ANCHORED);
  if (warnings.length !== 2) {
    failures.push(
      'repro-anchored: two layers with verify_radius ["apps/api/**"] and vitest filtered to their own scope\n' +
        '      expected: 2 warnings (one per layer)\n' +
        `      actual:   ${warnings.length} — ${JSON.stringify(warnings, null, 2)}`,
    );
  } else {
    if (!warnings.some((w) => w.includes('"api"') && w.includes('"domain-service"'))) {
      failures.push(
        'repro-anchored: the warning for layer "api" does not name the neighbouring layer "domain-service" its radius covers\n' +
          `      actual:   ${warnings.join(' | ')}`,
      );
    }
    if (!warnings.every((w) => w.includes('verify_radius'))) {
      failures.push(
        'repro-anchored: a warning does not name verify_radius\n' +
          `      actual:   ${warnings.join(' | ')}`,
      );
    }
  }
}

// ── 2-4. No false alarms on the correct shapes. ─────────────────────
for (const [label, text] of [
  ['repro-whole-suite (command runs the whole app suite)', WHOLE_SUITE],
  ['repro-ancestor (command path argument is above scope)', ANCESTOR_PATH],
  ['repro-no-radius (no verify_radius declared)', NO_RADIUS],
]) {
  const warnings = warn(text);
  if (warnings.length !== 0) {
    failures.push(
      `${label}\n` +
        '      expected: 0 warnings\n' +
        `      actual:   ${warnings.length} — ${JSON.stringify(warnings, null, 2)}`,
    );
  }
}

// ── 5. No false alarms on either shipped core. full-stack-app's schema
//    and hook layers both declare a package-wide radius; their commands
//    narrow by flag (`--testPathPattern={module}`), not by path, which
//    is not evidence the check can read — it abstains. ────────────────
for (const name of ['full-stack-app', 'landing-page']) {
  const core = await loadCore(join(ROOT, 'src/golden-cores', name, 'core.yaml'));
  const warnings = lintCore(core);
  if (warnings.length !== 0) {
    failures.push(
      `shipped core "${name}"\n` +
        '      expected: 0 warnings\n' +
        `      actual:   ${warnings.length} — ${JSON.stringify(warnings, null, 2)}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\nverify-covers-radius: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(
  'verify-covers-radius: ok — anchored commands warned (2), whole-suite/ancestor/no-radius silent, both shipped cores clean',
);
