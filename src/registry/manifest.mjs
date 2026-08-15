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
//   engine: "<semver range>"           which CLI versions can install it
//   selects_when: >                    prose the planner reads in Phase 0
//     ...folded block...
//   workspace: workspace/              omitted by a core that scaffolds nothing
//   template: CLAUDE.core.md           fills the CLAUDE.md shell's core section
//   template_adopted: <path>           optional second section, for adoption
//   agents: [<name>, ...]              agents/<name>.md in the package
//   skills: [<name>, ...]              skills/<name>/ in the package
//   vendor_skills: [<name>, ...]       vendor-skills/<name>/ in the package
//
// The YAML subset is top-level keys only: scalars, `null`, inline lists
// (which may wrap across lines), and folded block scalars (`>`). Nothing
// here nests, so a hand-rolled parser covers it without a dependency —
// the same stance src/db/core.mjs takes for core definitions.

const LIST_KEYS = new Set(['agents', 'skills', 'vendor_skills']);
const REQUIRED_KEYS = ['name', 'language', 'template'];

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
  return manifest;
}
