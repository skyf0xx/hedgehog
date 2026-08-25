// What version of the payload a project has, and whether a newer one exists.
//
// `init` and `update` stamp the version they wrote into
// `.hedgehog/version.json`. Without that stamp a project's installed
// agents and skills are indistinguishable from any other release's, so
// staleness can only be discovered by reading the files themselves.
//
// The registry lookup is cached and best-effort: a project that can't
// reach npm, or is offline entirely, gets no answer rather than an error.
// Nothing here is on the path of any command that has real work to do.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const VERSION_PATH = '.hedgehog/version.json';
const REGISTRY_URL = 'https://registry.npmjs.org/@skyf0xx/hedgehog/latest';

// How long a registry answer stays good. The payload ships daily, so a
// once-a-day question matches how often the answer can actually change,
// and keeps a session that runs many commands to a single network call.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// The check is advisory — it must never delay a command that has real
// work to do, so a registry that hangs is treated the same as one that
// says nothing.
const FETCH_TIMEOUT_MS = 1500;

/**
 * Record the payload version now installed in `root`. Called by both
 * `init` and `update`, so the stamp tracks the payload on disk rather
 * than whichever release first landed.
 */
export async function recordVersion(root, version) {
  const path = join(root, VERSION_PATH);
  const prior = await readVersionFile(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ ...prior, version, installedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return version;
}

async function readVersionFile(root) {
  try {
    return JSON.parse(await readFile(join(root, VERSION_PATH), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The payload version installed in `root`, or null for a project
 * installed before the stamp existed.
 */
export async function installedVersion(root) {
  const { version } = await readVersionFile(root);
  return typeof version === 'string' ? version : null;
}

/**
 * Compare two semver strings. Returns true when `a` is strictly newer
 * than `b`. Prerelease tags sort before their release, matching semver;
 * anything unparseable compares as equal so a malformed version can
 * never fabricate an update prompt.
 */
export function isNewer(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v ?? '').trim());
    return m
      ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] ?? null }
      : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i];
  }
  // Equal release numbers: a release outranks its own prereleases.
  if (pa.pre === pb.pre) return false;
  if (pa.pre === null) return true;
  if (pb.pre === null) return false;
  return pa.pre > pb.pre;
}

/**
 * The newest published version, from cache when it's fresh and from the
 * registry otherwise. Returns null on any failure — offline, timeout,
 * rate limit, malformed response. A null answer means "don't know", and
 * every caller treats that as "say nothing".
 */
export async function latestVersion(root, { force = false } = {}) {
  const cached = await readVersionFile(root);
  if (!force && cached.checkedAt && cached.latest) {
    const age = Date.now() - Date.parse(cached.checkedAt);
    if (age >= 0 && age < CACHE_TTL_MS) return cached.latest;
  }

  const latest = await fetchLatest();
  if (!latest) return null;

  // Cache alongside the install stamp rather than in a separate file, so
  // one read answers both halves of the question. Written only into a
  // `.hedgehog/` that already exists — a version lookup is a read, and
  // creating the directory here would leave one behind in a project that
  // never completed `init`, which `init`'s own preconditions rely on
  // being absent when they abort.
  const path = join(root, VERSION_PATH);
  try {
    await writeFile(
      path,
      `${JSON.stringify({ ...cached, latest, checkedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    // A read-only or absent .hedgehog just means no caching; the
    // answer we fetched is still good for this call.
  }
  return latest;
}

async function fetchLatest() {
  try {
    // No `accept` header. The abbreviated-metadata type
    // (application/vnd.npm.install-v1+json) is only valid on the
    // packument root — sending it to /latest returns 406, which this
    // function would swallow as "no answer" and the check would
    // silently never fire. Plain /latest returns just the one version
    // object, which is also far smaller than the full packument.
    const res = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const { version } = await res.json();
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/**
 * The full staleness picture for a project: what's installed, what's
 * published, and whether the gap is worth telling anyone about.
 *
 * `stale` is true only when both versions are known and the published
 * one is newer — an unknown on either side reads as "no", so a project
 * installed before stamping and an offline machine both stay quiet.
 */
export async function checkForUpdate(root, { force = false } = {}) {
  const installed = await installedVersion(root);
  const latest = await latestVersion(root, { force });
  return {
    installed,
    latest,
    stale: Boolean(installed && latest && isNewer(latest, installed)),
  };
}

/**
 * Whether the CLI binary actually executing right now — `binaryVersion`,
 * read from this package's own package.json, not from any project's
 * `.hedgehog/version.json` — is behind the newest published release.
 *
 * This is a distinct question from `checkForUpdate`: that one compares a
 * *project's* stamped version against latest, so a shadowed, stale global
 * install (a `hedgehog` binary resolved from PATH ahead of the scoped
 * `npx @skyf0xx/hedgehog` package) reads its own old code, sees the
 * project's stamp already at-or-past whatever it thinks "latest" is, and
 * says nothing — the exact case this function exists to catch instead, by
 * comparing the running code's own version rather than a file the running
 * code could itself be stale relative to.
 */
export async function checkBinaryStaleness(root, binaryVersion, { force = false } = {}) {
  const latest = await latestVersion(root, { force });
  return {
    binaryVersion,
    latest,
    stale: Boolean(binaryVersion && latest && isNewer(latest, binaryVersion)),
  };
}
