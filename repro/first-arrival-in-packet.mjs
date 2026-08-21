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
// "everything left of the first wildcard". A third layer's scope is a
// single literal file with no wildcard at all, deepseek-harness's own
// shape (`.hedgehog/dsh-smoke/{module}.md`) — its parent directory is
// never a package (no generator will ever write a package.json there),
// so it must never be flagged as a first arrival.
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
  - id: prompt
    depends_on: repository
    scope: [".fixture/prompts/{module}.md"]
    verify: "true"
    commit: "feat({module}): prompt"
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

  // A literal-file scope (no wildcard) never has a package root, so its
  // packet carries no FIRST ARRIVAL section at all — not even a false one.
  const prompt = cli(dir, ['show', 'TASKS-PROMPT']);
  check(
    'a single-file scope with no wildcard is never a first arrival',
    false,
    prompt.stdout.includes('FIRST ARRIVAL'),
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

// deepseek-harness's own `bundle` layer shape: a literal `package.json`
// glob sibling to a `lib/**` build-output glob. The package.json glob has
// no wildcard at all, so it used to be dropped by scopePackageRoot before
// it ever reached allRoots — leaving the outermost filter with no sibling
// root to recognise `lib` as nested under, and `lib` got flagged as its
// own first-arrival package even though the real package root already
// had a package.json on disk. Issue #252.
{
  const BUNDLE_CORE = `
id: bundle-shape-fixture
layers:
  - id: bundle
    scope: ["plugins/{module}/package.json", "plugins/{module}/lib/**"]
    verify: "true"
    commit: "feat({module}): bundle"
`;

  const dir = makeProject(BUNDLE_CORE, { git: true });
  try {
    addIntent(dir, 'nope-bot');
    check('plan exits 0', 0, cli(dir, ['plan']).status);

    // The package already exists, committed by an earlier step outside
    // this layer's own scope — the exact deepseek-harness scenario.
    mkdirSync(join(dir, 'plugins/nope-bot'), { recursive: true });
    writeFileSync(join(dir, 'plugins/nope-bot/package.json'), '{}\n');

    const packet = cli(dir, ['show', 'NOPE-BOT-BUNDLE']);
    check('show exits 0', 0, packet.status);
    check(
      'no FIRST ARRIVAL when the package.json glob\'s own root already exists',
      false,
      packet.stdout.includes('FIRST ARRIVAL'),
    );
  } finally {
    cleanup(dir);
  }
}

// The genuine first-arrival case for the same shape: nothing on disk yet
// names the real package root (plugins/nope-bot), not the lib/ glob's
// own root, and the widening it prints covers the package root.
{
  const BUNDLE_CORE = `
id: bundle-shape-fixture
layers:
  - id: bundle
    scope: ["plugins/{module}/package.json", "plugins/{module}/lib/**"]
    verify: "true"
    commit: "feat({module}): bundle"
`;

  const dir = makeProject(BUNDLE_CORE, { git: true });
  try {
    addIntent(dir, 'nope-bot');
    check('plan exits 0', 0, cli(dir, ['plan']).status);

    const packet = cli(dir, ['show', 'NOPE-BOT-BUNDLE']);
    checkContains('it names the real package root', packet.stdout, 'plugins/nope-bot does not exist yet');
    check(
      'it does not name the lib/ build-output directory as its own package',
      false,
      packet.stdout.includes('plugins/nope-bot/lib does not exist'),
    );
  } finally {
    cleanup(dir);
  }
}

report('the packet states a first arrival instead of leaving it to a failed verify');
