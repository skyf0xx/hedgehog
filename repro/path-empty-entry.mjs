#!/usr/bin/env node
// Repro: an empty PATH component made findBinary disagree with the shell.
//
// POSIX.1 XBD 8.3: a zero-length prefix in PATH is a legacy feature
// meaning the current working directory. This script proves that against
// the real /bin/sh first (premise, not faith), then asserts findBinary
// agrees. Before the fix it skipped empty components, so a binary the
// verify shell runs perfectly well was reported missing by `status` and
// refused by `verify` — a false negative in the direction that blocks a
// build that would have worked.
//
// Covers the four shapes an empty component takes: leading, trailing,
// interior, and PATH="" as a whole. Also pins the two neighbouring
// cases, so the fix doesn't overshoot: an unset PATH is not the same as
// an empty one (the shell falls back to confstr's /bin:/usr/bin and
// does not search the cwd), and a genuinely absent binary is still
// reported missing.
//
// Run: node repro/path-empty-entry.mjs

import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { check, cleanup, finish, hedgehog, makeProject, run, writeFileIn } from './papercuts-lib.mjs';
import { findBinary } from '../src/db/requires.mjs';

const PROBE = 'hh-papercut-probe';
const ABSENT = 'hh-papercut-definitely-absent';

const CORE = `id: demo
layers:
  - id: infra
    scope: ["infra/{module}/**"]
    verify: "${PROBE}"
    commit: "feat(infra): {module}"
    requires: ["${PROBE}"]
`;

const project = makeProject(CORE);

// The probe lives in the project root, which is the cwd both the CLI and
// the verify command run in.
writeFileIn(project, PROBE, '#!/bin/sh\necho probe-ran\n');
chmodSync(join(project, PROBE), 0o755);

// "." resolves against the process's own cwd, so the assertions below
// have to run from the project directory — the same place the CLI and
// the verify command run from.
const originalCwd = process.cwd();
process.chdir(project);

// Does a real shell find the probe with this PATH, from this cwd?
function shellFindsWith(pathValue) {
  const res = run('/usr/bin/env', [`PATH=${pathValue}`, '/bin/sh', '-c', PROBE], project);
  return res.status === 0;
}

try {
  console.log(`repro: path-empty-entry   (${project})`);

  const forms = [
    ['leading empty component', ':/usr/bin'],
    ['trailing empty component', '/usr/bin:'],
    ['interior empty component', '/usr/bin::/bin'],
    ['PATH empty entirely', ''],
  ];

  for (const [label, pathValue] of forms) {
    // ── premise: this is really what a POSIX shell does ───────────────
    check(`${label}: /bin/sh resolves it from the cwd`, shellFindsWith(pathValue), {
      expected: `/bin/sh -c ${PROBE} to succeed with PATH=${JSON.stringify(pathValue)}`,
      actual: 'shell could not run it — the premise does not hold on this platform',
    });

    // ── findBinary must agree with the shell it stands in for ─────────
    const found = findBinary(PROBE, { PATH: pathValue });
    check(`${label}: findBinary agrees`, found !== null, {
      expected: `a path for ${PROBE}`,
      actual: String(found),
    });
  }

  // ── the CLI, end to end: status must not cry wolf ────────────────────
  hedgehog(project, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']);
  hedgehog(project, ['plan', '--no-open']);

  const status = hedgehog(project, ['status'], { PATH: `:${process.env.PATH}` });
  check('status does not report a binary the verify shell can run', !status.all.includes('MISSING BINARIES'), {
    expected: 'no MISSING BINARIES section',
    actual: status.all.trim().slice(0, 600),
  });

  // ── neighbours the fix must not break ───────────────────────────────
  const absentFound = findBinary(ABSENT, { PATH: `:${process.env.PATH}` });
  check('a genuinely absent binary is still missing', absentFound === null, {
    expected: 'null',
    actual: String(absentFound),
  });

  const unsetPath = findBinary(PROBE, {});
  check('an unset PATH does not search the cwd (unlike an empty one)', unsetPath === null, {
    expected: `null — an unset PATH means confstr's /bin:/usr/bin, not "."`,
    actual: String(unsetPath),
  });
  const unsetFindsSh = findBinary('sh', {});
  check('an unset PATH still finds the shell defaults', unsetFindsSh !== null, {
    expected: 'a path for sh under /bin:/usr/bin',
    actual: String(unsetFindsSh),
  });
} finally {
  process.chdir(originalCwd);
  cleanup(project);
}

finish('path-empty-entry');
