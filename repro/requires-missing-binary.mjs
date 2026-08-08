#!/usr/bin/env node
// Repro: nothing declares or checks the binaries a layer's verify
// command needs.
//
// A layer's `verify` runs through /bin/sh with the caller's environment.
// A tool in ~/.local/bin that a login shell's profile puts on PATH is
// often absent from an agent's non-interactive shell, so the same core
// verifies green by hand and dies mid-build with a bare `exit 127`.
// Before the fix there was no `requires:` field, `hedgehog status` said
// nothing about missing tools, and the failure was that opaque 127 with
// the task marked blocked as if the layer's work were wrong.
//
// Asserts, against the real CLI in a throwaway repo whose core declares
// `requires: ["hedgehog-papercuts-absent-binary"]`:
//   1. `hedgehog status` names the missing binary and its layer, before
//      any build starts;
//   2. `hedgehog verify` on a claimed task refuses with a message naming
//      the binary and the layer;
//   3. that refusal does not blame the layer — the task is not left
//      blocked, because the verify command never ran.
//
// Run: node repro/requires-missing-binary.mjs

import { check, checkContains, cleanup, commitAll, finish, hedgehog, makeProject } from './_lib.mjs';

const ABSENT = 'hedgehog-papercuts-absent-binary';

const CORE = `id: demo
layers:
  - id: infra
    scope: ["infra/{module}/**"]
    verify: "${ABSENT} --version"
    commit: "feat(infra): {module}"
    requires: ["${ABSENT}"]
`;

const project = makeProject(CORE);

try {
  console.log(`repro: requires-missing-binary   (${project})`);

  hedgehog(project, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']);
  const planned = hedgehog(project, ['plan', '--no-open']);
  check('a core.yaml carrying requires: still plans', planned.status === 0, {
    expected: 'exit 0',
    actual: `exit ${planned.status}: ${planned.all.trim().slice(0, 400)}`,
  });

  // ── 1. status reports it before the build starts ────────────────────
  const status = hedgehog(project, ['status']);
  check('status exits 0', status.status === 0, {
    expected: 'exit 0',
    actual: `exit ${status.status}: ${status.all.trim().slice(0, 400)}`,
  });
  checkContains('status names the missing binary', status.all, ABSENT);
  checkContains('status names the layer that requires it', status.all, 'infra');
  checkContains('status flags it as a missing binary, not a task problem', status.all, 'MISSING BINARIES');

  // ── 2-3. verify refuses legibly, and doesn't blame the layer ────────
  // Clean tree first: the scope gate runs before the verify command, and
  // an uncommitted intent file would fail the task there instead, hiding
  // the behaviour under test.
  commitAll(project, 'chore: plan');

  const claimed = hedgehog(project, ['claim', '--owner', 'repro', '--count', '1']);
  check('claim succeeds', claimed.status === 0, {
    expected: 'exit 0',
    actual: `exit ${claimed.status}: ${claimed.all.trim().slice(0, 400)}`,
  });

  const verified = hedgehog(project, ['verify', 'ALPHA-INFRA', '--owner', 'repro']);
  check('verify exits non-zero', verified.status !== 0, {
    expected: 'non-zero exit',
    actual: `exit ${verified.status}`,
  });
  checkContains('verify names the missing binary', verified.all, ABSENT);
  checkContains('verify names the layer', verified.all, 'infra');
  checkContains('verify says the command was not run', verified.all, 'was not run');
  check('verify does not report a bare exit 127', !verified.all.includes('exit 127'), {
    expected: 'no "exit 127" in the message',
    actual: verified.all.trim().slice(0, 400),
  });

  const statusAfter = hedgehog(project, ['status']);
  check(
    'the task is not left blocked — the layer is not at fault',
    !statusAfter.all.includes('NEEDS ATTENTION'),
    {
      expected: 'no NEEDS ATTENTION section (task still building, lease intact)',
      actual: statusAfter.all.trim().slice(0, 600),
    },
  );
} finally {
  cleanup(project);
}

finish('requires-missing-binary');
