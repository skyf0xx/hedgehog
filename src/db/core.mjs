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

// The glob dialect is git's pathspec `:(glob)` — what verify.mjs actually
// enforces scope with: `*` and `?` stay inside one path segment, `**`
// spans any number of them. Every function below reads globs that way.
function segmentsOf(glob) {
  return glob.split('/').filter((segment) => segment !== '');
}

const WILDCARD = /[*?[]/;

// One segment pattern compiled to a regex over a single path segment.
// `{module}` and friends carry no wildcard characters, so they compile to
// literals and compare exactly — the same on both sides of any comparison,
// since plan.mjs fills scope and radius from the same module name.
function segmentRegExp(pattern) {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) source += '\\[';
      else {
        source += pattern.slice(i, end + 1);
        i = end;
      }
    } else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

function segmentMatches(pattern, segment) {
  return segmentRegExp(pattern).test(segment);
}

// Does a concrete path (as segments) match a glob? Standard `**`-aware
// walk. Used only on paths this file generated, to prove non-containment.
function matchesGlob(pathSegments, glob) {
  const g = segmentsOf(glob);
  const walk = (gi, pi) => {
    if (gi === g.length) return pi === pathSegments.length;
    if (g[gi] === '**') {
      for (let k = pi; k <= pathSegments.length; k++) {
        if (walk(gi + 1, k)) return true;
      }
      return false;
    }
    if (pi >= pathSegments.length) return false;
    if (!segmentMatches(g[gi], pathSegments[pi])) return false;
    return walk(gi + 1, pi + 1);
  };
  return walk(0, 0);
}

// Does the single-segment pattern `outer` match everything `inner` does?
// 'unknown' wherever deciding it would mean comparing two wildcard
// languages — the callers treat that as "can't prove", never as an error.
function segmentContains(outer, inner) {
  if (outer === inner) return 'yes';
  if (outer === '*') return 'yes'; // any one segment
  if (!WILDCARD.test(inner)) return segmentMatches(outer, inner) ? 'yes' : 'no';
  // inner is a wildcard pattern: `*` or `?` in it matches more than any
  // single literal can, so a literal outer provably misses something.
  if (!WILDCARD.test(outer)) return /[*?]/.test(inner) ? 'no' : 'unknown';
  return 'unknown';
}

// Structural containment: 'yes' only when every path `inner` matches is
// provably matched by `outer`. globPrefix (the scheduler's own algebra,
// which conflict.mjs uses) deliberately answers a different question —
// "could these two globs ever meet" — and a prefix comparison cannot
// decide containment: `a/*.ts` shares the prefix `a` with `a/b/**` while
// matching none of its paths. So this walks the segments instead.
function structuralContains(outer, inner) {
  const o = segmentsOf(outer);
  const i = segmentsOf(inner);
  let uncertain = false;
  let oi = 0;
  let ii = 0;
  while (oi < o.length) {
    if (o[oi] === '**') {
      // A trailing `**` covers everything below the prefix matched so far.
      // An interior one needs alignment this analysis doesn't attempt.
      if (oi === o.length - 1) return uncertain ? 'unknown' : 'yes';
      return 'unknown';
    }
    // outer still demands segments inner never produces, or inner can
    // expand across segments outer matches one at a time.
    if (ii >= i.length) return 'no';
    if (i[ii] === '**') return 'no';
    const rel = segmentContains(o[oi], i[ii]);
    if (rel === 'no') return 'no';
    if (rel === 'unknown') uncertain = true;
    oi++;
    ii++;
  }
  // outer matched exactly its own length; inner going deeper escapes it.
  if (ii < i.length) return 'no';
  return uncertain ? 'unknown' : 'yes';
}

// A few concrete paths the glob certainly matches, used as witnesses for
// non-containment. Returns none where a witness can't be constructed with
// certainty (interior `**`, character classes) — no witness means no
// proof, which the caller reads as "unknown", never as "covered".
function witnessPaths(glob) {
  const segments = segmentsOf(glob);
  const base = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === '**') {
      if (i !== segments.length - 1) return [];
      // `**` matches one segment and it matches two; both are witnesses,
      // and neither depends on whether it also matches zero.
      return [
        [...base, 'w1'],
        [...base, 'w1', 'w2'],
      ];
    }
    if (segment.includes('[')) return [];
    base.push(segment.replace(/[*?]/g, 'w'));
  }
  return [base];
}

// Is `glob` covered by the union of `globs`? 'yes' / 'no' / 'unknown'.
//
// 'no' is only ever returned with a proof: a concrete path `glob` matches
// that no glob in the set does. That matters because 'no' is a hard load
// failure — and because the union can cover something no single member
// covers (["a/b/*", "a/b/*/**"] together cover "a/b/**"), so "no member
// contains it" is not on its own grounds to reject a core. Unprovable
// either way comes back 'unknown' and is warned about, not thrown.
function coverage(globs, glob) {
  for (const candidate of globs) {
    if (structuralContains(candidate, glob) === 'yes') return 'yes';
  }
  for (const witness of witnessPaths(glob)) {
    if (!globs.some((candidate) => matchesGlob(witness, candidate))) return 'no';
  }
  return 'unknown';
}

// Literal directory segments of a glob — everything before its first
// wildcard, or the whole path when it has none. This is the scheduler's
// own globPrefix, except that a literal path counts as all of itself:
// globPrefix drops the last segment because a file path's directory is
// what could collide with another glob, while here the question is where
// a command's path argument sits relative to the scope.
function literalDirSegments(glob) {
  if (!WILDCARD.test(glob)) return segmentsOf(glob);
  return globPrefix(glob);
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
  const t = segmentsOf(token);
  const dir = literalDirSegments(glob);
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
      // Only a proven miss throws — coverage() returns 'no' solely when
      // it holds a concrete path in this layer's scope that no radius
      // glob matches. Anything it can't decide is left to lintCore.
      for (const glob of layer.scope) {
        if (coverage(layer.verify_radius, glob) === 'no') {
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
// Two checks. The first is the other half of validateCore's radius rule:
// where containment between the radius and the scope can be neither
// proven nor disproven, the author is told to check it rather than the
// core being rejected on a guess.
//
// The second is the verify-command-versus-verify_radius axis. A
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

    for (const glob of layer.scope) {
      if (coverage(layer.verify_radius, glob) === 'unknown') {
        warnings.push(
          `layer "${layer.id}": cannot prove verify_radius [${layer.verify_radius.join(', ')}] covers scope glob "${glob}" — check it by hand. A radius that misses part of its own scope leaves this layer writing files the scheduler believes nobody is reading (conflict.mjs compares scope against scope and radius against radius, never one against the other).`,
        );
      }
    }

    // Only a radius strictly wider than scope has an unexercised gap.
    const wider = layer.verify_radius.some(
      (glob) => coverage(layer.scope, glob) !== 'yes',
    );
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
          other.scope.some((glob) => coverage(layer.verify_radius, glob) === 'yes'),
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
