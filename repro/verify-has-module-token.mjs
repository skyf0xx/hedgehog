#!/usr/bin/env node
// Repro: a per-module layer's verify command can carry no {module} token
// and no module-scoped path argument, and nothing says so.
//
// validateCore already requires {module} in a per-module layer's scope —
// that's file-level isolation, a certainty the compiler depends on. This
// is the weaker, verify-side half: a layer whose scope isolates by
// module can still declare a verify with no evidence it distinguishes
// one module's run from another's. Observed for real — a six-module
// `deploy` layer's verify was a fixed `kubectl apply -f k8s/` with no
// {module} anywhere and no verify_radius declared. It compiled
// byte-identical across all six modules and could not tell deployed from
// reverted from never-built (upstream #9).
//
// Expected after the fix: lintCore() warns on the no-evidence case,
// stays silent the moment either {module} or a path argument shows up,
// stays silent on a layer that declares verify_radius (that's a
// different, already-checked claim — see verify-covers-radius.mjs), and
// reports nothing on either shipped core.
//
// No build graph, no sqlite — this is a core-definition-level defect.
// Run: node repro/verify-has-module-token.mjs

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore, parseCoreYaml, lintCore } from '../src/db/core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function warn(text) {
  return lintCore(parseCoreYaml(text));
}

// A — the observed defect: scope isolates by module, verify is a fixed
//     command with no {module} and no module-scoped path.
const NO_EVIDENCE = `
id: repro-no-evidence
layers:
  - id: deploy
    scope: ["k8s/{module}/**"]
    verify: "kubectl apply -f k8s/ && kubectl rollout status deployment/app"
    commit: "chore({module}): deploy"
`;

// B — correct: {module} appears literally in verify.
const MODULE_TOKEN = `
id: repro-module-token
layers:
  - id: deploy
    scope: ["k8s/{module}/**"]
    verify: "kubectl apply -f k8s/{module}/ && kubectl rollout status deployment/{module}"
    commit: "chore({module}): deploy"
`;

// C — correct: no {module} literal, but a path argument anchors the
//     command to the module (pathArguments sees it even without the
//     literal placeholder string, since the compiler already substituted
//     it — this models a hand-authored verify that references a module
//     path directly).
const PATH_ARGUMENT = `
id: repro-path-argument
layers:
  - id: deploy
    scope: ["k8s/{module}/**"]
    verify: "kubectl apply -f k8s/{module}/manifests/"
    commit: "chore({module}): deploy"
`;

// D — correct: verify_radius declared, so the layer is on record as
//     deliberately reading wider than its own module — the same
//     exemption verify-covers-radius.mjs's WHOLE_SUITE case relies on.
const RADIUS_DECLARED = `
id: repro-radius-declared
layers:
  - id: deploy
    scope: ["k8s/{module}/**"]
    verify: "kubectl apply -f k8s/ && pnpm test"
    verify_radius: ["k8s/**"]
    commit: "chore({module}): deploy"
`;

// E — exempt: once: true carries no {module} anywhere by construction.
const ONCE_LAYER = `
id: repro-once
layers:
  - id: bootstrap
    scope: ["terraform/**"]
    verify: "terraform apply -auto-approve"
    once: true
    commit: "chore(infra): bootstrap"
  - id: deploy
    depends_on: bootstrap
    scope: ["k8s/{module}/**"]
    verify: "kubectl apply -f k8s/{module}/"
    commit: "chore({module}): deploy"
`;

// F — exempt: exclusive: true is a declared join/integration layer, no
//     per-module scope to distinguish.
const EXCLUSIVE_LAYER = `
id: repro-exclusive
layers:
  - id: deploy
    scope: ["k8s/{module}/**"]
    verify: "kubectl apply -f k8s/{module}/"
    commit: "chore({module}): deploy"
  - id: join
    depends_on: deploy
    scope: ["**"]
    verify: "kubectl apply -f k8s/"
    exclusive: true
    commit: "chore(infra): join"
`;

// G — not module-axis at all: no layer's scope carries {module}, so the
//     check has nothing to apply to.
const LINEAR_CHAIN = `
id: repro-linear
layers:
  - id: deploy
    scope: ["k8s/**"]
    verify: "kubectl apply -f k8s/"
    commit: "chore(infra): deploy"
`;

// ── 1. The defect is reported. ──────────────────────────────────────────
{
  const warnings = warn(NO_EVIDENCE);
  if (warnings.length !== 1) {
    failures.push(
      'repro-no-evidence: a deploy layer with no {module} and no path argument\n' +
        '      expected: 1 warning\n' +
        `      actual:   ${warnings.length} — ${JSON.stringify(warnings, null, 2)}`,
    );
  } else if (!warnings[0].includes('"deploy"') || !warnings[0].includes('{module}')) {
    failures.push(`repro-no-evidence: warning doesn't name the layer or {module}\n      actual: ${warnings[0]}`);
  }
}

// ── 2-7. No false alarms on the correct/exempt shapes. ──────────────────
for (const [label, text] of [
  ['repro-module-token ({module} literal in verify)', MODULE_TOKEN],
  ['repro-path-argument (module-scoped path argument)', PATH_ARGUMENT],
  ['repro-radius-declared (verify_radius on record)', RADIUS_DECLARED],
  ['repro-once (once: true layer)', ONCE_LAYER],
  ['repro-exclusive (exclusive: true layer)', EXCLUSIVE_LAYER],
  ['repro-linear (not module-axis)', LINEAR_CHAIN],
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

// ── 8. No false alarms on either shipped core. ──────────────────────────
for (const name of ['full-stack-app', 'landing-page']) {
  const core = await loadCore(join(ROOT, 'repro/fixtures/cores', `${name}.core.yaml`));
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
  console.error(`\nverify-has-module-token: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(
  'verify-has-module-token: ok — no-evidence deploy layer warned, module-token/path-argument/radius/once/exclusive/linear cases silent, both shipped cores clean',
);
