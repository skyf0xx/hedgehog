// Which core package a project installed, and at which version.
//
// `init` records it so `update` can refresh that core's agents and skills
// from the same package without being told which core the project is on.
// A project whose core was chosen at planning intake rather than at
// install time has nothing recorded until its bootstrap-core skill lands
// the core — `installedCore` returns null until then, and `update` limits
// itself to the shared payload.
//
// `authored` has a second entry point with no `init` step at all:
// `hedgehog-adopt` brings the discipline to a repo that already exists by
// writing `.hedgehog/core.yaml` itself, directly, and never calls
// `recordCore` (see that skill, shipped in
// @skyf0xx/hedgehog-core-authored — adoption has no npm package of its
// own to fetch, just a core.yaml and adoption.md derived from the
// existing repo). `hedgehog core record-adopted` (bin/cli.mjs) is the
// record path for that case instead: it lands the authored package's
// agents/skills — otherwise never installed, since adoption's `init` runs
// with no `--core` flag and `bootstrap` is skipped entirely for adoption
// — and calls `recordCore` with `adopted: true`. That flag is the one
// thing distinguishing an adopted record from a normal one: `update`'s
// resolveInstalledCore refreshes an adopted project's payload the same as
// any other (same package, same agents/skills, kept current) but must
// never treat `record.name` changing upstream, or the record going
// missing, as license to fetch and install a *different* core the way it
// would for a project that chose one at `init` — adoption's core is a
// fixed fact of the repo (its `.hedgehog/core.yaml`), not a choice
// `update` gets to revisit.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const ADOPTED_CORE_NAME = 'authored';

const CORE_PATH = '.hedgehog/core.json';

/**
 * Record the core a project installed and the exact version resolved for
 * it. Written after the core's files land, so the record describes what
 * is on disk. `adopted: true` marks a record written by `hedgehog core
 * record-adopted` rather than by `init` — see the module comment above.
 */
export async function recordCore(root, { name, version, adopted = false }) {
  const path = join(root, CORE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      { core: name, version, installedAt: new Date().toISOString(), ...(adopted ? { adopted: true } : {}) },
      null,
      2,
    )}\n`,
  );
}

/**
 * The core `update` should refresh — `{ name, version, adopted }` — or
 * null when this project has no core installed yet. `adopted` is always a
 * boolean, `false` for every record `init` writes.
 */
export async function installedCore(root) {
  try {
    const { core, version, adopted } = JSON.parse(await readFile(join(root, CORE_PATH), 'utf8'));
    return core ? { name: core, version, adopted: adopted === true } : null;
  } catch {
    return null;
  }
}
