#!/usr/bin/env node
// Repro: `pattern: hexagonal` checks direction alone (no adapter marker
// exists yet — see #314's "Not in this issue"). The head layer (the
// domain, by convention) must have no depends_on, and every other
// layer's depends_on chain must terminate at the head with no cycle. Not
// required by #314's own test list, but the check is real code with real
// failure modes, so it gets the same coverage as layered/vertical-slice.
//
// Run: node repro/pattern-hexagonal-checks-direction.mjs

import { check, finish } from './papercuts-lib.mjs';
import { validateCore } from '../src/db/core.mjs';

console.log('repro: pattern-hexagonal-checks-direction');

// domain (head, no depends_on) <- repository <- controller: every chain
// terminates at domain. Must validate clean.
const VALID = {
  id: 'valid-hexagonal',
  pattern: 'hexagonal',
  layers: [
    { id: 'domain', scope: ['domain/**'], verify: 'true', commit: 'feat: domain' },
    {
      id: 'repository',
      depends_on: 'domain',
      scope: ['repository/**'],
      verify: 'true',
      commit: 'feat: repository',
    },
    {
      id: 'controller',
      depends_on: 'domain',
      scope: ['controller/**'],
      verify: 'true',
      commit: 'feat: controller',
    },
  ],
};
try {
  validateCore(VALID);
  check('two adapters both pointing at the domain validates clean', true, {});
} catch (err) {
  check('two adapters both pointing at the domain validates clean', false, {
    expected: 'no error',
    actual: err.message,
  });
}

// The head itself has a depends_on — it can't be the sink if it also
// depends on something.
const HEAD_HAS_DEPENDENCY = {
  id: 'head-has-dependency',
  pattern: 'hexagonal',
  layers: [
    {
      id: 'domain',
      depends_on: 'infra',
      scope: ['domain/**'],
      verify: 'true',
      commit: 'feat: domain',
    },
    { id: 'infra', scope: ['infra/**'], verify: 'true', commit: 'feat: infra' },
  ],
};
try {
  validateCore(HEAD_HAS_DEPENDENCY);
  check('a head layer with a depends_on throws', false, {
    expected: 'throws',
    actual: 'validated without error',
  });
} catch (_err) {
  check('a head layer with a depends_on throws', true, {});
}

// A non-head layer with no depends_on is a second, ambiguous root.
const SECOND_ROOT = {
  id: 'second-root',
  pattern: 'hexagonal',
  layers: [
    { id: 'domain', scope: ['domain/**'], verify: 'true', commit: 'feat: domain' },
    { id: 'orphan', scope: ['orphan/**'], verify: 'true', commit: 'feat: orphan' },
  ],
};
try {
  validateCore(SECOND_ROOT);
  check('a non-head layer with no depends_on throws', false, {
    expected: 'throws',
    actual: 'validated without error',
  });
} catch (_err) {
  check('a non-head layer with no depends_on throws', true, {});
}

// A cycle that never reaches the head.
const CYCLE = {
  id: 'cycle',
  pattern: 'hexagonal',
  layers: [
    { id: 'domain', scope: ['domain/**'], verify: 'true', commit: 'feat: domain' },
    { id: 'x', depends_on: 'y', scope: ['x/**'], verify: 'true', commit: 'feat: x' },
    { id: 'y', depends_on: 'x', scope: ['y/**'], verify: 'true', commit: 'feat: y' },
  ],
};
try {
  validateCore(CYCLE);
  check('a cycle that never reaches the head throws', false, {
    expected: 'throws',
    actual: 'validated without error',
  });
} catch (_err) {
  check('a cycle that never reaches the head throws', true, {});
}

finish('pattern-hexagonal-checks-direction');
