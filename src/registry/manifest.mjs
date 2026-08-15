// The `hedgehog-core.yaml` manifest every core package ships at its root.
// This file owns that document's shape; `fetch.mjs` reads it and `plan()`
// in bin/cli.mjs installs from it.
//
// The manifest names what a core contributes to a project and where each
// piece lives inside the package:
//
//   name: <core name>                  matches its registry entry
//   flag: <cli flag> | null            null when the core has no install flag
//   language: <scalar>
//   engine: "^<major>.<minor>.<patch>" which CLI versions can install it
//   workspace: workspace/              omitted by a core that scaffolds nothing
//   template: CLAUDE.core.md           fills the CLAUDE.md shell's core section
//   template_adopted: <path>           optional second section, for adoption
//   agents: [<name>, ...]              agents/<name>.md in the package
//   skills: [<name>, ...]              skills/<name>/ in the package
//   vendor_skills: [<name>, ...]       vendor-skills/<name>/ in the package
//
// The prose the planner reads in Phase 0 to choose a core is not among
// these keys. Core selection happens before any package is fetched, so
// `src/registry/cores.json` owns that prose as its `selects_when` field
// and is the only copy anything reads. A manifest carrying that key is
// refused, since a second copy could only drift from the one in use.
//
// The YAML subset is top-level keys only: scalars, `null`, inline lists
// (which may wrap across lines), and folded block scalars (`>`). Nothing
// here nests, so a hand-rolled parser covers it without a dependency —
// the same stance src/db/core.mjs takes for core definitions.

const LIST_KEYS = new Set(['agents', 'skills', 'vendor_skills']);
const REQUIRED_KEYS = ['name', 'language', 'template'];

// The one range form a manifest's `engine` may take: a caret range over a
// three-part version. Caret is the whole vocabulary on purpose — a core
// declares the major line of the engine it installs against, and anything
// wider or narrower than that is a shape this table does not resolve.
const ENGINE_RANGE = /^\^(\d+)\.(\d+)\.(\d+)$/;
const ENGINE_VERSION = /^(\d+)\.(\d+)\.(\d+)/;

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === 'null' || s === '~' || s === '') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length > 1) ||
    (s.startsWith("'") && s.endsWith("'") && s.length > 1)
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseInlineList(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  return inner
    .split(',')
    .map((item) => parseScalar(item))
    .filter((item) => item !== null);
}

/**
 * Parse a core package's `hedgehog-core.yaml` into a plain object.
 * Throws when a key the installer depends on is missing, so a malformed
 * package fails at fetch rather than part-way through writing files.
 */
export function parseCoreManifest(text, source = 'hedgehog-core.yaml') {
  const lines = text.split('\n');
  const manifest = {};

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(stripComment(raw));
    if (!match) continue;
    const [, key, rest] = match;
    const value = rest.trim();

    // A folded block scalar: every following line indented under this key
    // is one paragraph, joined with spaces.
    if (value === '>' || value === '|') {
      const body = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s+\S/.test(lines[i + 1]))) {
        body.push(lines[++i].trim());
      }
      manifest[key] = body.join(' ').trim();
      continue;
    }

    // An inline list, which may wrap across several lines before closing.
    if (value.startsWith('[')) {
      let text = value;
      while (!text.trimEnd().endsWith(']') && i + 1 < lines.length) {
        text += ` ${stripComment(lines[++i]).trim()}`;
      }
      manifest[key] = parseInlineList(text);
      continue;
    }

    manifest[key] = parseScalar(value);
  }

  for (const key of REQUIRED_KEYS) {
    if (manifest[key] == null) {
      throw new Error(`${source}: missing required key "${key}"`);
    }
  }
  for (const key of LIST_KEYS) {
    if (manifest[key] == null) manifest[key] = [];
    else if (!Array.isArray(manifest[key])) {
      throw new Error(`${source}: "${key}" must be a list`);
    }
  }
  if (manifest.selects_when != null) {
    throw new Error(
      `${source}: carries "selects_when", which src/registry/cores.json owns.\n` +
        `The planner reads that prose in Phase 0, before any core package is fetched, so\n` +
        `the registry entry is the only copy anything reads. Drop the key from the\n` +
        `manifest and revise the core's entry in cores.json instead.`,
    );
  }
  return manifest;
}

/**
 * Check a core's declared `engine` range against the CLI installing it.
 *
 * A core states which engine line it installs against; an engine older
 * than that line writes a payload the core's own skills expect features
 * from, so the install stops here rather than part-way through.
 *
 * @param {object} manifest - a parsed manifest, carrying `engine`
 * @param {string} engineVersion - the CLI's own package.json `version`
 * @param {string} source - what to name in the error
 */
export function assertEngineSatisfies(manifest, engineVersion, source = 'hedgehog-core.yaml') {
  const required = manifest.engine;
  if (required == null) return;

  const range = ENGINE_RANGE.exec(String(required).trim());
  if (!range) {
    throw new Error(
      `${source}: unsupported engine range "${required}".\n` +
        `A core states the engine line it installs against as a caret range over a\n` +
        `three-part version, like "^5.0.0". Nothing else resolves.`,
    );
  }

  const installed = ENGINE_VERSION.exec(String(engineVersion).trim());
  if (!installed) {
    throw new Error(`${source}: cannot read the installed engine version ("${engineVersion}").`);
  }

  const [, wantMajor, wantMinor, wantPatch] = range.map(Number);
  const [, haveMajor, haveMinor, havePatch] = installed.map(Number);

  // Caret semantics: the same major line, at or above the stated version.
  const satisfied =
    haveMajor === wantMajor &&
    (haveMinor > wantMinor || (haveMinor === wantMinor && havePatch >= wantPatch));

  if (!satisfied) {
    throw new Error(
      `This core needs Hedgehog ${required}, and the CLI running is ${engineVersion}.\n\n` +
        `The core's agents and skills are written against that engine line, so installing\n` +
        `them on this one would land a payload the core cannot drive. Run the install\n` +
        `again through the current release:\n\n` +
        `  npx @skyf0xx/hedgehog@latest init\n`,
    );
  }
}
