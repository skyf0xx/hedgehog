// A first arrival in a package is a fact the packet states, not one the
// builder discovers from a failed verify.
//
// Every layer scope names a directory inside a package, so on the first
// module through that layer the generator also creates the package shell —
// package.json, tsconfig*.json, src/index.ts — all necessarily outside a
// {module}-bearing glob. Learning that from `hedgehog verify` rejecting
// those paths costs a five-command recovery, because by then the task is
// blocked and "widen it before building" is no longer available.
//
// The signal is on disk: the package the scope points into has no
// package.json yet. Once it does, module two through the same layer gets
// the narrow scope and no section.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeProject,
  addIntent,
  cli,
  cleanup,
  check,
  checkContains,
  report,
} from './_lib.mjs';

// Both shapes the full-stack-app core uses: a package root ABOVE the
// {module} segment (packages/contracts/src/{module}), and one BELOW it
// (libs/{module}/repository), which is why the root cannot simply be
// "everything left of the first wildcard".
const CORE = `
id: first-arrival-fixture
layers:
  - id: contract
    scope: ["packages/contracts/src/{module}/**"]
    verify: "true"
    commit: "feat({module}): contract"
  - id: repository
    depends_on: contract
    scope: ["libs/{module}/repository/**"]
    verify: "true"
    commit: "feat({module}): repository"
`;

const dir = makeProject(CORE, { git: true });
try {
  addIntent(dir, 'tasks');
  check('plan exits 0', 0, cli(dir, ['plan']).status);

  const packet = cli(dir, ['show', 'TASKS-CONTRACT']);
  check('show exits 0', 0, packet.status);

  checkContains('the packet names the first arrival', packet.stdout, 'FIRST ARRIVAL');
  checkContains(
    'it names the package that does not exist yet',
    packet.stdout,
    'packages/contracts does not exist yet',
  );
  checkContains(
    'it prints the override command for this task, ready to run',
    packet.stdout,
    'hedgehog override add TASKS-CONTRACT',
  );
  checkContains(
    'it grants the package root',
    packet.stdout,
    "--scope 'packages/contracts/*'",
  );
  checkContains(
    'and the non-recursive src, for index.ts and shared utils beside it',
    packet.stdout,
    "--scope 'packages/contracts/src/*'",
  );

  // A package root BELOW the {module} segment resolves to the substituted
  // path, not to `libs`.
  const repo = cli(dir, ['show', 'TASKS-REPOSITORY']);
  checkContains(
    'a root below {module} is named with the module substituted in',
    repo.stdout,
    'libs/tasks/repository does not exist yet',
  );

  // The package landing is what clears it — module two through the same
  // layer inherits a package that already exists.
  mkdirSync(join(dir, 'packages/contracts'), { recursive: true });
  writeFileSync(join(dir, 'packages/contracts/package.json'), '{}\n');

  const after = cli(dir, ['show', 'TASKS-CONTRACT']);
  check(
    'once the package exists the section is gone',
    false,
    after.stdout.includes('FIRST ARRIVAL'),
  );
  checkContains('and the scope itself is unchanged', after.stdout, 'ALLOWED SCOPE');
} finally {
  cleanup(dir);
}

report('the packet states a first arrival instead of leaving it to a failed verify');
