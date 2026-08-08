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

import { readFile } from 'node:fs/promises';
import { globPrefix } from './conflict.mjs';

function stripComment(line) {
  // '#' only starts a comment outside a quoted string.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
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

// ── verify-radius checks ────────────────────────────────────────────────
// A layer's `scope` is what it may write; its `verify_radius` is what its
// verify command reads. conflict.mjs compares like with like — scope
// against scope, then radius against radius — so the two below are the
// only things about that pair a file can decide on its own.

// Full segment list of a glob: the literal path itself when it has no
// wildcard, otherwise the scheduler's own segment-wise prefix. globPrefix
// deliberately drops a literal glob's last segment (it answers "could
// these two globs ever meet"); coverage is a containment question, so a
// literal path counts as all of itself here.
function globSegments(glob) {
  if (glob.search(/[*?[]/) === -1) {
    return glob.split('/').filter((segment) => segment !== '');
  }
  return globPrefix(glob);
}

// True when `outer` is at least as broad as `inner` — outer's segments are
// a segment-wise prefix of inner's. Deliberately permissive about the
// wildcard tail (`a/*.ts` counts as covering `a/b/**`): every caller uses
// this to decide whether to complain, so the error direction is silence.
function globCovers(outer, inner) {
  const o = globSegments(outer);
  const i = globSegments(inner);
  if (o.length > i.length) return false;
  for (let k = 0; k < o.length; k++) {
    if (o[k] !== i[k]) return false;
  }
  return true;
}

function covered(globs, glob) {
  return globs.some((candidate) => globCovers(candidate, glob));
}

// Path-like arguments in a verify command, as evidence of what the command
// anchors itself to. Only tokens that are unambiguously a relative path
// count: anything flag-shaped, absolute, variable-interpolated, a URL, or
// carrying an `=` is dropped rather than guessed at. The list is evidence,
// never a claim of completeness — a command with no path arguments yields
// an empty list, which the lint reads as "no evidence", not "reads
// nothing".
function pathArguments(command) {
  const tokens = command.split(/[\s;|&()]+/);
  const paths = [];
  for (const raw of tokens) {
    const token = raw.replace(/^['"]+/, '').replace(/['"]+$/, '');
    if (!token.includes('/')) continue;
    if (!/^[A-Za-z0-9._{]/.test(token)) continue; // flags, redirects, absolute paths
    if (token.includes('=') || token.includes('$') || token.includes('://')) continue;
    const normalized = token.replace(/^\.\//, '').replace(/\/+$/, '');
    if (normalized !== '') paths.push(normalized);
  }
  return paths;
}

// True when `token` names a path at or below `glob`'s own directory —
// "inside", as opposed to an ancestor of it. The token is matched at any
// segment offset, because a verify command's path arguments are relative
// to whatever directory the runner chdir'd into (`pnpm --filter api exec
// vitest run src/{module}/http/` is repo-relative to `apps/api`), not to
// the repo root. At least one segment must match: a zero-overlap
// alignment would make every token "inside" every recursive glob.
function tokenInsideGlob(token, glob) {
  const t = token.split('/').filter((segment) => segment !== '');
  const dir = globSegments(glob);
  const recursive = glob.includes('**');
  for (let i = 0; i < dir.length; i++) {
    const overlap = Math.min(t.length, dir.length - i);
    if (overlap === 0) continue;
    let matches = true;
    for (let j = 0; j < overlap; j++) {
      if (t[j] !== dir[i + j]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    // Shorter than what's left of the glob's own directory: the token is
    // an ancestor of the scope, so the command reaches wider, not narrower.
    if (t.length < dir.length - i) continue;
    // Deeper than the glob's directory only lands inside a recursive glob.
    if (t.length > dir.length - i && !recursive) continue;
    return true;
  }
  return false;
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

    // A declared radius REPLACES scope on the verify axis — conflict.mjs's
    // verifyRadius() returns the declared list alone, never the union with
    // scope — and conflicts() only ever compares scope against scope and
    // radius against radius. Nothing compares one task's scope against
    // another's radius, so the writes-vs-reads case (A writes a file B's
    // verify reads) is only visible to the scheduler when every layer's
    // radius contains its own scope. The unset default (radius = scope)
    // holds that invariant for free; a declared radius that drops part of
    // its own scope breaks it silently, and the two tasks co-schedule.
    if (layer.verify_radius !== null) {
      if (layer.verify_radius.length === 0) {
        throw new Error(
          `layer "${layer.id}" declares an empty verify_radius — omit the field to fall back to scope (conflict.mjs's verifyRadius), rather than declaring a radius that covers nothing`,
        );
      }
      for (const glob of layer.scope) {
        if (!covered(layer.verify_radius, glob)) {
          throw new Error(
            `layer "${layer.id}" declares verify_radius [${layer.verify_radius.join(', ')}], which does not cover its own scope glob "${glob}" — a declared radius replaces scope on the verify axis (conflict.mjs), so anything in scope but outside the radius is a file this layer writes while the scheduler believes no one is reading it`,
          );
        }
      }
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

// Heuristic checks on a core definition — everything that is a smell
// rather than a certainty, so it warns instead of throwing (validateCore
// owns the certainties). Returns a list of human-readable strings; empty
// means nothing detectable is wrong.
//
// The one check here is the verify-command-versus-verify_radius axis. A
// layer's radius is its claim that its verify command reads that whole
// set, and the scheduler serializes other tasks against the claim. When
// the command's only path arguments sit inside the layer's own `scope`,
// the command is anchored to the scope directory and everything between
// scope and the radius goes unexercised — the layer collects the
// serialization without doing the reading, and a task that breaks a
// neighbour inside its own declared radius still commits green.
//
// It fires on evidence only. A command with no path arguments at all
// (`pnpm nx test db --testPathPattern={module}`) yields nothing to reason
// from: whether that flag's filter reaches the whole radius depends on
// the test corpus, not on this file, so the check abstains rather than
// asserting a conclusion it can't see. That blind spot is exactly why
// hedgehog-core-design carries the question as an authoring rule too.
export function lintCore(core) {
  const warnings = [];
  for (const layer of core.layers) {
    if (layer.verify_radius === null) continue;

    // Only a radius strictly wider than scope has an unexercised gap.
    const wider = layer.verify_radius.some((glob) => !covered(layer.scope, glob));
    if (!wider) continue;

    const paths = pathArguments(layer.verify);
    if (paths.length === 0) continue; // no evidence either way — abstain
    const anchored = paths.every((path) =>
      layer.scope.some((glob) => tokenInsideGlob(path, glob)),
    );
    if (!anchored) continue; // something in the command reaches outside scope

    const neighbours = core.layers
      .filter(
        (other) =>
          other.id !== layer.id &&
          other.scope.some((glob) => covered(layer.verify_radius, glob)),
      )
      .map((other) => `"${other.id}"`);
    const reach =
      neighbours.length > 0
        ? ` The radius covers layer ${neighbours.join(', ')}'s scope, which this command never runs.`
        : '';

    warnings.push(
      `layer "${layer.id}": verify_radius [${layer.verify_radius.join(', ')}] is wider than scope, but every path in verify (${paths
        .map((path) => `"${path}"`)
        .join(', ')}) is inside that scope — the command only exercises what the layer writes.${reach} A task that breaks something else inside the declared radius passes green. Widen the command to the radius, or narrow the radius to what the command reads.`,
    );
  }
  return warnings;
}

export async function loadCore(path) {
  const text = await readFile(path, 'utf8');
  return validateCore(parseCoreYaml(text));
}
