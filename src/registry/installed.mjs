// Which core package a project installed, and at which version.
//
// `init` records it when it names a core, and `hedgehog core install`
// (bin/cli.mjs) records it when the core is chosen later: at planning
// intake, where `bootstrap` installs planner's choice, or by
// `hedgehog-adopt` through its `core record-adopted` alias. `update` reads
// the record to refresh that core's agents and skills from the same
// package without being told which core the project is on, and
// `installedCore` returns null until one is recorded, in which case
// `update` limits itself to the shared payload.
//
// `adopted` is recorded the same way as every other core. Its name marks
// a project whose core is a fixed fact of the repo (its
// `.hedgehog/core.yaml`): `update` refreshes the same package's agents and
// skills, and never treats the record changing upstream, or going
// missing, as license to fetch and install a different core.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const ADOPTED_CORE_NAME = 'adopted';

const CORE_PATH = '.hedgehog/core.json';

/**
 * Record the core a project installed and the exact version resolved for
 * it. Written after the core's files land, so the record describes what
 * is on disk.
 */
export async function recordCore(root, { name, version }) {
  const path = join(root, CORE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ core: name, version, installedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

/**
 * The core `update` should refresh — `{ name, version }` — or null when
 * this project has no core installed yet. `name === 'adopted'` marks an
 * adopted repo — see the module comment above.
 */
export async function installedCore(root) {
  try {
    const { core, version } = JSON.parse(await readFile(join(root, CORE_PATH), 'utf8'));
    return core ? { name: core, version } : null;
  } catch {
    return null;
  }
}
