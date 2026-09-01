#!/usr/bin/env node
// Repro: `pattern: layered` claims a strict linear chain — one dependent
// per layer. Two layers sharing a depends_on parent is branching, not a
// chain, and validateCore must reject it.
//
// Run: node repro/pattern-layered-rejects-branching-chain.mjs

import { check, finish } from './papercuts-lib.mjs';
import { validateCore } from '../src/db/core.mjs';

console.log('repro: pattern-layered-rejects-branching-chain');

// `b` and `c` both depend_on `a` — a fork, not a linear chain.
const BRANCHING = {
  id: 'branching',
  pattern: 'layered',
  layers: [
    { id: 'a', scope: ['a/**'], verify: 'true', commit: 'feat: a' },
    { id: 'b', depends_on: 'a', scope: ['b/**'], verify: 'true', commit: 'feat: b' },
    { id: 'c', depends_on: 'a', scope: ['c/**'], verify: 'true', commit: 'feat: c' },
  ],
};

try {
  validateCore(BRANCHING);
  check('a branching chain under layered throws', false, {
    expected: 'throws',
    actual: 'validated without error',
  });
} catch (err) {
  check('a branching chain under layered throws', true, {});
  check('message names the shared parent layer "a"', err.message.includes('"a"'), {
    expected: 'message mentioning layer "a"',
    actual: err.message,
  });
}

// A genuine linear chain under layered must validate clean — the check
// above must be a real check, not always-throw.
const LINEAR = {
  id: 'linear',
  pattern: 'layered',
  layers: [
    { id: 'schema', scope: ['schema/**'], verify: 'true', commit: 'feat: schema' },
    {
      id: 'repository',
      depends_on: 'schema',
      scope: ['repository/**'],
      verify: 'true',
      commit: 'feat: repository',
    },
    {
      id: 'service',
      depends_on: 'repository',
      scope: ['service/**'],
      verify: 'true',
      commit: 'feat: service',
    },
  ],
};

try {
  validateCore(LINEAR);
  check('a genuine linear chain under layered validates clean', true, {});
} catch (err) {
  check('a genuine linear chain under layered validates clean', false, {
    expected: 'no error',
    actual: err.message,
  });
}

// A layer disconnected from the head (a 2-cycle between two non-head
// layers) has no shared parent and every non-head layer has exactly one
// depends_on — the two checks above don't catch it. Reachability must.
const DISCONNECTED = {
  id: 'disconnected',
  pattern: 'layered',
  layers: [
    { id: 'head', scope: ['head/**'], verify: 'true', commit: 'feat: head' },
    { id: 'x', depends_on: 'y', scope: ['x/**'], verify: 'true', commit: 'feat: x' },
    { id: 'y', depends_on: 'x', scope: ['y/**'], verify: 'true', commit: 'feat: y' },
  ],
};

try {
  validateCore(DISCONNECTED);
  check('a chain disconnected from the head throws', false, {
    expected: 'throws',
    actual: 'validated without error',
  });
} catch (_err) {
  check('a chain disconnected from the head throws', true, {});
}

finish('pattern-layered-rejects-branching-chain');
