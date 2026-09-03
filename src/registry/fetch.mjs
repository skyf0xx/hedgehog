// Fetches a core package and reads its manifest.
//
// A core ships as its own npm package (see cores.json) carrying the
// agents, skills, workspace, and CLAUDE.md section that core needs.
// `fetchCore` resolves that package with `npm pack`, extracts the tarball,
// and returns the parsed `hedgehog-core.yaml` manifest alongside the
// directory it was extracted to — everything `init` needs to plan its
// writes against a core it did not ship with.
//
// Extractions are cached at ~/.hedgehog/cores/<name>/<version>/, keyed by
// the exact version npm resolved rather than the range asked for, so a
// second install of the same core is a directory read with no network.

import { mkdir, mkdtemp, readFile, readdir, rm, rename, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { parseCoreManifest, assertEngineSatisfies } from './manifest.mjs';

const execFileAsync = promisify(execFile);

// The CLI's own version, which a core's `engine` range is checked against
// every time a manifest is read.
const ENGINE_VERSION = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

const MANIFEST_NAME = 'hedgehog-core.yaml';

// npm's own tarball root — every published package extracts under this.
const TARBALL_ROOT = 'package';

export const CORE_CACHE_ROOT = join(homedir(), '.hedgehog', 'cores');

// Resolution source for core packages. Unset, cores resolve from the
// public npm registry by their `package` and `version` in cores.json. Set
// to a directory, each core resolves from `<dir>/<package-basename>`
// instead — a local checkout or a packed tarball — which is how a core is
// exercised end to end before it is published.
const SOURCE_ENV = 'HEDGEHOG_CORE_SOURCE';

// Skip cache (both reads and writes) when set; every invocation gets a fresh
// npm pack with no persistence to ~/.hedgehog/cores/. Useful when the
// caller's use of the fetched core is ephemeral or when accurate npm
// download stats are needed.
const NO_CACHE_ENV = 'HEDGEHOG_CORE_NO_CACHE';

const exists = (p) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

// What `npm pack` is asked to resolve for this core: a registry spec, or
// a local path under HEDGEHOG_CORE_SOURCE named for the package's last
// path segment (`@skyf0xx/hedgehog-core-landing-page` →
// `hedgehog-core-landing-page`).
function packSpec(entry) {
  const source = process.env[SOURCE_ENV];
  if (!source) return `${entry.package}@${entry.version}`;
  return join(source, entry.package.split('/').pop());
}

/**
 * Resolve, extract, and read one core package.
 *
 * @param {object} entry - a cores.json entry (`name`, `package`, `version`)
 * @returns {Promise<{manifest: object, root: string, version: string,
 *   engineAdvisory: string|null}>} the parsed hedgehog-core.yaml, the
 *   directory the package extracted to, the exact version resolved, and a
 *   line to print when the CLI is ahead of the core's engine line.
 */
export async function fetchCore(entry) {
  const staged = await packAndExtract(entry);
  const version = await packageVersion(staged.root);
  const cached = join(CORE_CACHE_ROOT, entry.name, version);

  // Read the manifest off the staged copy first. The cache is what
  // `cores list` reports as reusable and what an offline `update` reads
  // back, so only a core this engine can actually install belongs in it —
  // a manifest that fails here throws before anything is cached.
  let read;
  try {
    read = await readManifest(staged.root, entry);
  } catch (err) {
    await rm(staged.tmp, { recursive: true, force: true });
    throw err;
  }

  // When NO_CACHE_ENV is set, skip cache entirely and return the staged
  // extraction directly, leaving staged.tmp in place (since staged.root
  // lives inside it).
  if (process.env[NO_CACHE_ENV]) {
    return { ...read, root: staged.root, version };
  }

  // Another install may have cached this exact version between the pack
  // and now; its copy is as good as this one, so keep it and drop ours.
  if (await exists(cached)) {
    await rm(staged.tmp, { recursive: true, force: true });
    return { ...read, root: cached, version };
  }

  await mkdir(join(CORE_CACHE_ROOT, entry.name), { recursive: true });
  await rename(staged.root, cached);
  await rm(staged.tmp, { recursive: true, force: true });
  return { ...read, root: cached, version };
}

/**
 * The cached extraction for a core at a given version, or null when that
 * version has never been fetched. Lets a caller that already knows which
 * version it wants — `update`, reading the version a project recorded —
 * work offline without asking npm to resolve anything.
 */
export async function cachedCore(entry, version) {
  const root = join(CORE_CACHE_ROOT, entry.name, version);
  if (!(await exists(join(root, MANIFEST_NAME)))) return null;
  return { ...(await readManifest(root, entry)), root, version };
}

async function packAndExtract(entry) {
  const spec = packSpec(entry);
  const tmp = await mkdtemp(join(tmpdir(), `hedgehog-core-${entry.name}-`));

  let tarball;
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', spec, '--pack-destination', tmp, '--json', '--loglevel', 'error'],
      { cwd: tmp, maxBuffer: 64 * 1024 * 1024 },
    );
    tarball = join(tmp, JSON.parse(stdout)[0].filename);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(unresolvableMessage(entry, spec, err), { cause: err });
  }

  try {
    await execFileAsync('tar', ['-xzf', tarball, '-C', tmp]);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(`Could not extract ${entry.package} from ${tarball}: ${err.message}`, { cause: err });
  }

  const root = join(tmp, TARBALL_ROOT);
  if (!(await exists(join(root, MANIFEST_NAME)))) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(
      `${entry.package} carries no ${MANIFEST_NAME}, so there is nothing to install from it.\n` +
        `Every Hedgehog core package ships that manifest at its root; a package without one\n` +
        `is not a core. Check the package name in the registry entry for "${entry.name}".`,
    );
  }
  return { tmp, root };
}

async function packageVersion(root) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  return version;
}

async function readManifest(root, entry) {
  const manifest = parseCoreManifest(
    await readFile(join(root, MANIFEST_NAME), 'utf8'),
    `${entry.package}/${MANIFEST_NAME}`,
  );
  if (manifest.name !== entry.name) {
    throw new Error(
      `${entry.package} declares core "${manifest.name}", but the registry lists it as "${entry.name}".\n` +
        `The package and the registry entry have to agree on the core's name.`,
    );
  }
  const engineAdvisory = assertEngineSatisfies(
    manifest,
    ENGINE_VERSION,
    `${entry.package}/${MANIFEST_NAME}`,
  );
  return { manifest, engineAdvisory };
}

// npm's own failure text is a wall of registry detail; what a user can act
// on is which package could not be resolved and the two reasons it usually
// can't be.
function unresolvableMessage(entry, spec, err) {
  const detail = String(err.stderr || err.message).trim().split('\n').slice(0, 3).join('\n  ');
  return (
    `Could not resolve the ${entry.name} core package (${spec}).\n\n` +
    `  ${detail}\n\n` +
    `That package carries the core's workspace, agents, and skills. Check that you\n` +
    `are online and that npm can reach the registry, then re-run. To resolve from a\n` +
    `local checkout or a packed tarball instead, point ${SOURCE_ENV} at the\n` +
    `directory holding it.`
  );
}

/**
 * The engine line the newest cached extraction of a core declares, or
 * null when that core has never been fetched. `cores list` reports it so
 * the engine line each core is written against is visible at the point a
 * core is chosen, rather than only once an install has run.
 */
export async function cachedEngine(name, versions) {
  const newest = [...versions].sort(compareVersions).pop();
  if (!newest) return null;
  try {
    const text = await readFile(join(CORE_CACHE_ROOT, name, newest, MANIFEST_NAME), 'utf8');
    return parseCoreManifest(text, `${name}/${MANIFEST_NAME}`).engine ?? null;
  } catch {
    return null;
  }
}

// Orders `1.0.5` after `1.0.0` rather than before it, which a plain
// string sort would not.
function compareVersions(a, b) {
  const parts = (v) => String(v).split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

/**
 * List which versions of a core are already extracted in the cache.
 * Reported by `hedgehog cores list` so a user can see what an install
 * would reuse rather than fetch.
 */
export async function cachedVersions(name) {
  try {
    return (await readdir(join(CORE_CACHE_ROOT, name), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
