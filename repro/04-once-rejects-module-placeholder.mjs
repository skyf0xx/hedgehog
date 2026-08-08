// A `once: true` layer compiles one task for the whole build, so there is
// no module to substitute. `{module}` left in its scope/verify/commit is
// a core-definition mistake and must be rejected with a legible message —
// not silently carried through as a glob matching a literal "{module}"
// directory, and not baked into a commit message `hedgehog db rebuild`
// later matches history against.
//
// Against the pre-cardinality loader this fails: `once` is an unknown
// field, so the layer compiles per module and the command exits 0.

import { makeProject, addIntent, cli, cleanup, check, checkContains, report } from './_lib.mjs';

const BAD_CORE = `
id: bad-once
layers:
  - id: cluster
    scope: ["infra/{module}/cluster/**"]
    verify: "true"
    once: true
    commit: "chore(infra): cluster"
  - id: schema
    depends_on: cluster
    scope: ["libs/{module}/schema/**"]
    verify: "true"
    commit: "feat({module}): schema"
`;

const dir = makeProject(BAD_CORE);
try {
  addIntent(dir, 'users');
  const planned = cli(dir, ['plan']);

  check('plan exits non-zero', true, planned.status !== 0);

  const output = `${planned.stdout}${planned.stderr}`;
  checkContains('names the offending layer', output, 'cluster');
  checkContains('names the offending placeholder', output, '{module}');
  checkContains('explains why', output, 'once: true');
} finally {
  cleanup(dir);
}

report('04 — a once layer with {module} in scope is rejected');
