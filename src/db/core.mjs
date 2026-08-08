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
//       once: <bool>                  # optional, default false
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
      // Cardinality flag (plan.mjs) — absent means one task per intent, the
      // module axis. `once: true` means one task for the whole build, no
      // matter how many intents the graph holds.
      once: layer.once !== undefined && parseScalar(layer.once) === 'true',
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
  const layerIds = new Set();
  for (const layer of core.layers) {
    if (!layer.id) throw new Error('layer missing id');
    if (!layer.scope || layer.scope.length === 0) {
      throw new Error(`layer "${layer.id}" missing scope`);
    }
    if (!layer.verify) {
      throw new Error(`layer "${layer.id}" missing verify`);
    }
    layerIds.add(layer.id);
  }

  // `depends_on` naming a layer that doesn't exist compiles to a
  // dependency row pointing at a task id nothing ever inserts — a foreign
  // key failure halfway through `hedgehog plan` rather than a legible
  // error here. It also has to resolve for the cardinality rules below:
  // which edges a layer compiles depends on whether its parent is `once`.
  for (const layer of core.layers) {
    if (!layer.depends_on) continue;
    if (!layerIds.has(layer.depends_on)) {
      throw new Error(
        `layer "${layer.id}" depends_on "${layer.depends_on}", which is not a layer of core "${core.id}"`,
      );
    }
  }

  // A `once: true` layer compiles a single task for the whole build, so
  // there is no module to substitute into its templates. Left unchecked,
  // a stray {module} would survive verbatim into scope_globs — a glob
  // matching a literal "{module}" directory, i.e. nothing — and into the
  // commit message, which is what `hedgehog db rebuild` matches history
  // against.
  for (const layer of core.layers) {
    if (!layer.once) continue;
    const templated = [
      ...layer.scope,
      layer.verify,
      layer.commit,
      ...(layer.verify_radius ?? []),
    ].join('');
    if (templated.includes('{module}')) {
      throw new Error(
        `layer "${layer.id}" is once: true, so it compiles one task for the whole build and has no module to substitute — remove {module} from its scope/verify/commit/verify_radius`,
      );
    }
  }

  // Every layer `once` leaves no per-intent layer at all: no intent would
  // ever compile a task, and plan.mjs has nothing to key its
  // already-compiled check on.
  if (core.layers.every((layer) => layer.once)) {
    throw new Error(
      `core "${core.id}" has no per-intent layer — every layer is once: true, so no intent would compile any task`,
    );
  }

  // A module-axis core's per-module layers must all vary by module in
  // scope — a partial mix means some layer's file-level isolation
  // silently collapses across modules at plan.mjs's fillModule step.
  // scope (not verify/commit) is the check because scope is what
  // determines file-level isolation. Two kinds of layer are exempt.
  // `exclusive: true` is the declared escape hatch for irreducibly
  // global work (a join/integration layer), which by definition has no
  // per-module scope to declare and needs none — the scheduler already
  // never co-schedules it with anything. `once: true` is exempt for a
  // stronger reason: it compiles one task, not one per module, so there
  // is nothing for a {module} in its scope to isolate — and requiring one
  // would reject exactly the cross-cutting layers `once` exists to
  // express.
  const isModuleAxis = core.layers.some((layer) =>
    layer.scope.join('').includes('{module}'),
  );
  if (isModuleAxis) {
    for (const layer of core.layers) {
      if (layer.exclusive || layer.once) continue;
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
