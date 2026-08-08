// Core-definition loader. Parses `core.yaml` (shipped Golden Cores under
// src/golden-cores/*/core.yaml, or an authored .hedgehog/core.yaml) into
// the same in-memory shape either way. See
// hedgehog-persistent-build-graph.md, "Core definitions".
//
// The YAML subset here is deliberately narrow — top-level `id` (scalar)
// and `layers` (a list of flat maps of scalars/inline string lists). That
// subset is all a core definition ever needs, so this hand-rolled parser
// covers it without adding a YAML dependency, the same "no dependency"
// stance src/db/schema.mjs takes with node:sqlite.
//
// Quoted scalars are unescaped properly, because `verify` is a shell
// command and a half-parsed command is worse than an unparsed one:
//   - double-quoted: the YAML escape set — \" \\ \/ \n \t \r \0 \a \b
//     \v \f \e \<space> \N \_ \L \P, plus \xNN, \uNNNN and \UNNNNNNNN.
//     An unrecognised escape, a trailing backslash and an unterminated
//     quote all throw, so a scalar this parser cannot represent fails
//     loudly instead of reaching the shell with its backslashes intact.
//   - single-quoted: no backslash escapes at all; `''` is the only
//     escape and yields one literal quote.
// Still outside the subset: multi-line (block) scalars, and a comma
// inside a quoted entry of an inline list, which parseInlineList splits
// on regardless.

import { readFile } from 'node:fs/promises';

function stripComment(line) {
  // '#' only starts a comment outside a quoted string.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    // Inside a double-quoted scalar a backslash escapes the next
    // character, so `\"` must not be read as the closing quote — without
    // this, a '#' later in the same scalar looks like it sits outside the
    // string and the value is silently truncated at that point.
    // Single-quoted scalars have no backslash escape; their `''` escape
    // toggles inSingle off and straight back on, which lands correctly.
    if (inDouble && ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

// The single-character escapes YAML defines for a double-quoted scalar
// (spec 5.7, "Escaped Characters"). `\<space>` and `\/` are included; the
// line-continuation `\<newline>` is not, because a core definition's
// scalars are always single-line.
const ESCAPES = new Map([
  ['0', '\0'],
  ['a', '\x07'],
  ['b', '\b'],
  ['t', '\t'],
  ['\t', '\t'],
  ['n', '\n'],
  ['v', '\v'],
  ['f', '\f'],
  ['r', '\r'],
  ['e', '\x1b'],
  [' ', ' '],
  ['"', '"'],
  ['/', '/'],
  ['\\', '\\'],
  ['N', '\u0085'], // next line
  ['_', '\u00a0'], // non-breaking space
  ['L', '\u2028'], // line separator
  ['P', '\u2029'], // paragraph separator
]);

// The hex escapes, keyed by how many hex digits each consumes.
const HEX_ESCAPES = new Map([
  ['x', 2],
  ['u', 4],
  ['U', 8],
]);

// Index of the quote that closes a double-quoted scalar opened at 0, or
// -1 if the scalar is unterminated. A backslash escapes whatever follows.
function closingDoubleQuote(s) {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i;
  }
  return -1;
}

// The single-quoted equivalent. There is no backslash escape here — the
// only escape is `''`, which stands for one literal quote.
function closingSingleQuote(s) {
  for (let i = 1; i < s.length; i++) {
    if (s[i] !== "'") continue;
    if (s[i + 1] === "'") i++;
    else return i;
  }
  return -1;
}

function unescapeDoubleQuoted(body, raw) {
  if (!body.includes('\\')) return body;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      out += body[i];
      continue;
    }
    const code = body[i + 1];
    const simple = ESCAPES.get(code);
    if (simple !== undefined) {
      out += simple;
      i++;
      continue;
    }
    const width = HEX_ESCAPES.get(code);
    if (width !== undefined) {
      const digits = body.slice(i + 2, i + 2 + width);
      if (digits.length !== width || !/^[0-9A-Fa-f]+$/.test(digits)) {
        throw new Error(
          `invalid \\${code} escape (expected ${width} hex digits) in: ${raw}`,
        );
      }
      out += String.fromCodePoint(parseInt(digits, 16));
      i += 1 + width;
      continue;
    }
    // An unrecognised escape is an error rather than a pass-through. A
    // verify command whose backslashes survive into the shell is the
    // silent-wrong-value failure this whole function exists to prevent.
    throw new Error(
      code === undefined
        ? `trailing backslash in double-quoted scalar: ${raw}`
        : `unknown escape "\\${code}" in double-quoted scalar: ${raw}`,
    );
  }
  return out;
}

// Unwraps a quoted scalar and resolves its escapes, or returns a plain
// scalar as-is. Escapes matter because `verify` is a shell command: a
// scalar whose backslashes are left in place still loads, still
// validates, and still lists correctly, but runs as a different command
// than the one written.
function parseScalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"')) {
    const end = closingDoubleQuote(s);
    if (end === -1) throw new Error(`unterminated double-quoted scalar: ${raw}`);
    if (end !== s.length - 1) {
      throw new Error(`unexpected content after a double-quoted scalar: ${raw}`);
    }
    return unescapeDoubleQuoted(s.slice(1, end), raw);
  }
  if (s.startsWith("'")) {
    const end = closingSingleQuote(s);
    if (end === -1) throw new Error(`unterminated single-quoted scalar: ${raw}`);
    if (end !== s.length - 1) {
      throw new Error(`unexpected content after a single-quoted scalar: ${raw}`);
    }
    return s.slice(1, end).replaceAll("''", "'");
  }
  return s;
}

function parseInlineList(raw) {
  const s = raw.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) {
    throw new Error(`expected an inline list ("[...]"), got: ${raw}`);
  }
  const inner = s.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((item) => parseScalar(item));
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

// Parses the narrow subset of YAML a core definition needs:
//   id: <scalar>
//   layers:
//     - id: <scalar>
//       depends_on: <scalar>          # optional
//       scope: [<scalar>, <scalar>]
//       verify: <scalar>
//       commit: <scalar>
//       exclusive: <bool>             # optional, default false
//       verify_radius: [<scalar>, ...] # optional, default null (falls back to scope)
export function parseCoreYaml(text) {
  const rawLines = text.split('\n');
  const lines = [];
  for (const rawLine of rawLines) {
    const noComment = stripComment(rawLine);
    if (noComment.trim() === '') continue;
    lines.push({ indent: indentOf(noComment), text: noComment.trim() });
  }

  const core = { id: undefined, layers: [] };
  let i = 0;

  while (i < lines.length && lines[i].indent === 0) {
    const line = lines[i];
    if (line.text === 'layers:') {
      i++;
      break;
    }
    const match = line.text.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) throw new Error(`unparseable line: ${line.text}`);
    const [, key, value] = match;
    if (key === 'id') core.id = parseScalar(value);
    i++;
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line.indent === 0) break;
    const itemMatch = line.text.match(/^-\s*([A-Za-z0-9_]+):\s*(.*)$/);
    if (!itemMatch) throw new Error(`expected a layer list item: ${line.text}`);
    const layerIndent = line.indent;
    const layer = {};
    const [, firstKey, firstValue] = itemMatch;
    layer[firstKey] = firstValue;
    i++;

    while (i < lines.length && lines[i].indent > layerIndent) {
      const fieldMatch = lines[i].text.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!fieldMatch) throw new Error(`unparseable layer field: ${lines[i].text}`);
      const [, fieldKey, fieldValue] = fieldMatch;
      layer[fieldKey] = fieldValue;
      i++;
    }

    core.layers.push({
      id: parseScalar(layer.id ?? ''),
      depends_on:
        layer.depends_on !== undefined ? parseScalar(layer.depends_on) : null,
      scope: layer.scope !== undefined ? parseInlineList(layer.scope) : [],
      verify: layer.verify !== undefined ? parseScalar(layer.verify) : '',
      commit: layer.commit !== undefined ? parseScalar(layer.commit) : '',
      // Scheduler isolation flag (conflict.mjs) — absent means concurrency-safe.
      exclusive:
        layer.exclusive !== undefined && parseScalar(layer.exclusive) === 'true',
      // null (not []) is the sentinel conflict.mjs reads as "fall back to scope".
      verify_radius:
        layer.verify_radius !== undefined
          ? parseInlineList(layer.verify_radius)
          : null,
    });
  }

  return core;
}

// Enforces the interview's rule (spec: "Authored cores") — a layer without
// scope or without a verify command is rejected. Applied uniformly to
// shipped and authored cores alike; the loader has no shipped-core-only
// leniency.
export function validateCore(core) {
  if (!core.id) throw new Error('core definition missing top-level id');
  if (!Array.isArray(core.layers) || core.layers.length === 0) {
    throw new Error('core definition has no layers');
  }
  for (const layer of core.layers) {
    if (!layer.id) throw new Error('layer missing id');
    if (!layer.scope || layer.scope.length === 0) {
      throw new Error(`layer "${layer.id}" missing scope`);
    }
    if (!layer.verify) {
      throw new Error(`layer "${layer.id}" missing verify`);
    }
  }

  // A module-axis core's per-module layers must all vary by module in
  // scope — a partial mix means some layer's file-level isolation
  // silently collapses across modules at plan.mjs's fillModule step.
  // scope (not verify/commit) is the check because scope is what
  // determines file-level isolation. An `exclusive: true` layer is
  // exempt: exclusive is the declared escape hatch for irreducibly
  // global work (a join/integration layer), which by definition has no
  // per-module scope to declare and needs none — the scheduler already
  // never co-schedules it with anything.
  const isModuleAxis = core.layers.some((layer) =>
    layer.scope.join('').includes('{module}'),
  );
  if (isModuleAxis) {
    for (const layer of core.layers) {
      if (layer.exclusive) continue;
      if (!layer.scope.join('').includes('{module}')) {
        throw new Error(
          `layer "${layer.id}" has no {module} in scope, but core "${core.id}" is module-axis (another layer's scope uses {module})`,
        );
      }
    }
  }

  return core;
}

export async function loadCore(path) {
  const text = await readFile(path, 'utf8');
  return validateCore(parseCoreYaml(text));
}
