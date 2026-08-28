#!/usr/bin/env node
// Repro / regression guard: `pattern` is new and optional, so a core.yaml
// that omits it must keep parsing and validating exactly as before.
//
// The failure this guards against is the obvious way to implement the
// field — treating "unset" as itself something to check — which would
// reject every core.yaml written before this field existed, including
// every shipped core. It also pins the shape the rest of the feature
// relies on: an omitted `pattern` parses to `null` (never undefined), and
// `validateCore` runs zero conformance checks against it.
//
// Run: node repro/pattern-unset-still-valid.mjs

import { join } from 'node:path';
import { check, finish, REPO_ROOT } from './papercuts-lib.mjs';
import { loadCore, parseCoreYaml, validateCore } from '../src/db/core.mjs';

console.log('repro: pattern-unset-still-valid');

// ── parseCoreYaml: an omitted pattern parses to null ───────────────────
const CORE_NO_PATTERN = `id: demo
layers:
  - id: only
    scope: ["src/**"]
    verify: "true"
    commit: "feat: only"
`;
const parsed = parseCoreYaml(CORE_NO_PATTERN);
check('parseCoreYaml: pattern defaults to null', parsed.pattern === null, {
  expected: 'null',
  actual: String(parsed.pattern),
});

// ── validateCore: an unset pattern never throws, on any shape ──────────
// Deliberately messy — branching, no linear chain — to prove the absence
// of a pattern skips conformance checking entirely rather than falling
// back to some default check.
const MESSY = {
  id: 'messy',
  layers: [
    { id: 'a', scope: ['a/**'], verify: 'true', commit: 'feat: a' },
    { id: 'b', depends_on: 'a', scope: ['b/**'], verify: 'true', commit: 'feat: b' },
    { id: 'c', depends_on: 'a', scope: ['c/**'], verify: 'true', commit: 'feat: c' },
  ],
};
try {
  validateCore(MESSY);
  check('validateCore: unset pattern never throws, even on a branching graph', true, {});
} catch (err) {
  check('validateCore: unset pattern never throws, even on a branching graph', false, {
    expected: 'no error',
    actual: err.message,
  });
}

// ── every shipped core still loads and validates ────────────────────────
// Each of these now declares its own pattern (skyf0xx/hedgehog#315), so
// this no longer asserts pattern === null — it asserts what this block's
// own name always meant: the shipped core loads and validates without
// throwing, whatever it declares.
for (const name of ['full-stack-app', 'landing-page', 'pwa-app', 'deepseek-harness']) {
  const path = join(REPO_ROOT, 'repro/fixtures/cores', `${name}.core.yaml`);
  try {
    await loadCore(path);
    check(`${name}: loads and validates`, true, {});
  } catch (err) {
    check(`${name}: loads and validates`, false, {
      expected: 'loads cleanly',
      actual: err.message,
    });
  }
}

finish('pattern-unset-still-valid');
