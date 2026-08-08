// Shared fixture for the packet reproductions. Builds a throwaway
// Hedgehog project in a temp dir (its own `hedgehog-honesty-` prefix, so
// it never collides with another working copy's temp dirs), compiles one
// intent through a two-layer authored core, and runs the real CLI's
// `hedgehog next` against it.
//
// The graph is built through the same modules the CLI itself imports
// (dbInit / addIntent / loadCore / planTasks) rather than by shelling out
// to `hedgehog plan`, because `plan` spawns a detached graph server and
// an OS browser-open on success — neither belongs in a reproduction. The
// assertion target, `hedgehog next`, is driven as the real CLI process.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const CLI = join(REPO_ROOT, 'bin/cli.mjs');

const CORE_YAML = `id: honesty-fixture
layers:
  - id: schema
    scope: [src/schema/**]
    verify: node --version
    commit: "feat(schema): fixture"
  - id: service
    depends_on: schema
    scope: [src/service/**]
    verify: node --version
    commit: "feat(service): fixture"
`;

const INTENT = {
  id: 'billing',
  goal: 'Charge a customer for a subscription period',
  outcome: 'An invoice exists for every closed period',
  priority: 1,
  rules: [
    'An invoice is immutable once issued',
    'A period with no usage still produces an invoice',
  ],
};

// Creates the temp project and returns its absolute path. Caller is
// responsible for cleanup via `cleanup(dir)` — never by globbing the
// temp root, which would delete sibling fixtures.
export async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'hedgehog-honesty-'));
  await mkdir(join(dir, '.hedgehog'), { recursive: true });
  await writeFile(join(dir, '.hedgehog/core.yaml'), CORE_YAML);

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const { dbInit, openDb } = await import(join(REPO_ROOT, 'src/db/init.mjs'));
    const { addIntent } = await import(join(REPO_ROOT, 'src/db/intent.mjs'));
    const { loadCore } = await import(join(REPO_ROOT, 'src/db/core.mjs'));
    const { planTasks } = await import(join(REPO_ROOT, 'src/db/plan.mjs'));

    await dbInit();
    const core = await loadCore(join(dir, '.hedgehog/core.yaml'));
    const db = openDb();
    try {
      await addIntent(db, INTENT);
      planTasks(db, core);
    } finally {
      db.close();
    }
  } finally {
    process.chdir(cwd);
  }

  return dir;
}

// Runs the real CLI's `next` in the fixture and returns its stdout.
// NO_COLOR keeps the output free of ANSI escapes so it can be compared
// literally.
export function runNext(dir) {
  return execFileSync(process.execPath, [CLI, 'next'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}

// Minimal assertion helpers — no test framework, by design.
export function fail(what, expected, actual) {
  console.error(`FAIL  ${what}`);
  console.error('\n--- expected ---');
  console.error(expected);
  console.error('\n--- actual ---');
  console.error(actual);
  console.error();
  process.exitCode = 1;
}

export function pass(what) {
  console.log(`PASS  ${what}`);
}
