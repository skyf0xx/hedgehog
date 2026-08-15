// Which core package a project installed, and at which version.
//
// `init` records it so `update` can refresh that core's agents and skills
// from the same package without being told which core the project is on.
// A project whose core was chosen at planning intake rather than at
// install time has nothing recorded until its bootstrap-core skill lands
// the core — `installedCore` returns null until then, and `update` limits
// itself to the shared payload.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
 * this project has no core installed yet.
 */
export async function installedCore(root) {
  try {
    const { core, version } = JSON.parse(await readFile(join(root, CORE_PATH), 'utf8'));
    return core ? { name: core, version } : null;
  } catch {
    return null;
  }
}
