#!/usr/bin/env node
// Repro / regression guard: `requires:` is optional, so a core.yaml that
// omits it must keep loading and behaving exactly as before.
//
// The failure this guards against is the obvious way to implement the
// declaration — making `requires` a validated field — which would reject
// every core.yaml written before it existed, including both shipped
// Golden Cores. It also pins the shape the rest of the fix relies on:
// an omitted `requires` parses to [] (not undefined), so consumers never
// need a null check and a core that declares nothing can never report a
// missing binary.
//
// Asserts:
//   1. both shipped cores (src/golden-cores/*/core.yaml) load and
//      validate, with every other field unchanged;
//   2. every layer of them exposes requires === [] — declaring nothing;
//   3. a hand-written core.yaml with no requires: plans, and `hedgehog
//      status` reports no missing binaries for it;
//   4. validateCore accepts a core object with no requires field at all
//      (an in-memory core, as any other caller would build one).
//
// Run: node repro/core-without-requires.mjs

import { join } from 'node:path';
import { check, checkContains, cleanup, finish, hedgehog, makeProject, REPO_ROOT } from './_lib.mjs';
import { loadCore, validateCore } from '../src/db/core.mjs';

console.log('repro: core-without-requires');

// ── 1-2. shipped cores ────────────────────────────────────────────────
for (const name of ['full-stack-app', 'landing-page']) {
  const path = join(REPO_ROOT, 'src/golden-cores', name, 'core.yaml');
  let core;
  try {
    core = await loadCore(path);
  } catch (err) {
    check(`${name}: loads`, false, { expected: 'loads and validates', actual: err.message });
    continue;
  }

  check(`${name}: id survives`, core.id === name, {
    expected: name,
    actual: String(core.id),
  });
  check(`${name}: has layers`, core.layers.length > 0, {
    expected: '>0 layers',
    actual: String(core.layers.length),
  });

  const broken = core.layers.filter(
    (l) => !l.id || !Array.isArray(l.scope) || l.scope.length === 0 || !l.verify || !l.commit,
  );
  check(`${name}: every layer keeps id/scope/verify/commit`, broken.length === 0, {
    expected: 'no layer missing a field',
    actual: broken.map((l) => l.id || '(unnamed)').join(', '),
  });

  const badRequires = core.layers.filter(
    (l) => !Array.isArray(l.requires) || l.requires.length !== 0,
  );
  check(`${name}: every layer declares requires === []`, badRequires.length === 0, {
    expected: 'requires === [] on every layer (omitted means declares nothing)',
    actual: badRequires
      .map((l) => `${l.id}: ${JSON.stringify(l.requires)}`)
      .join(', ') || '(none)',
  });
}

// ── 4. in-memory core with no requires field at all ───────────────────
try {
  validateCore({
    id: 'in-memory',
    layers: [{ id: 'only', scope: ['src/**'], verify: 'true', commit: 'feat: only' }],
  });
  check('validateCore accepts a layer with no requires field', true, {});
} catch (err) {
  check('validateCore accepts a layer with no requires field', false, {
    expected: 'no error',
    actual: err.message,
  });
}

// ── 3. a project whose core.yaml never mentions requires ──────────────
const CORE = `id: demo
layers:
  - id: infra
    scope: ["infra/{module}/**"]
    verify: "true"
    commit: "feat(infra): {module}"
`;

const project = makeProject(CORE);
try {
  hedgehog(project, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']);
  const planned = hedgehog(project, ['plan', '--no-open']);
  check('a core without requires still plans', planned.status === 0, {
    expected: 'exit 0',
    actual: `exit ${planned.status}: ${planned.all.trim().slice(0, 400)}`,
  });

  const status = hedgehog(project, ['status']);
  check('status on a core without requires exits 0', status.status === 0, {
    expected: 'exit 0',
    actual: `exit ${status.status}: ${status.all.trim().slice(0, 400)}`,
  });
  check('status reports no missing binaries', !status.all.includes('MISSING BINARIES'), {
    expected: 'no MISSING BINARIES section',
    actual: status.all.trim().slice(0, 600),
  });
  checkContains('status still shows the ready list', status.all, 'READY');
} finally {
  cleanup(project);
}

finish('core-without-requires');
