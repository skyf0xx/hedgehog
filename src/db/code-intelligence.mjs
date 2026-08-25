// Pre-computed task context: the symbols and files a task's scope
// actually touches, resolved from a code-intelligence index at compile
// time and written onto the task row by plan.mjs.
//
// This is the only file in the build graph that knows the shape of the
// CodeGraphContext calls. It imports nothing from CGC — the `provider`
// is injected by the caller (bin/cli.mjs builds it, rebuild.mjs and
// every repro harness pass null or a fake), so the graph keeps
// compiling with no index present and no dependency to install.
//
// The index the calls read models a repo as: Repository(path, name),
// File(path, language, hash), Module(name), Class(name, path,
// start_line, end_line), Function(name, path, signature, docstring,
// complexity, start_line, end_line); joined by CONTAINS, IMPORTS,
// CALLS, INHERITS, IMPLEMENTS. File.path and Function.path are what map
// a symbol back onto a Hedgehog scope glob.
//
// Failure is always null, never a throw. Resolution runs inside
// plan.mjs's BEGIN IMMEDIATE transaction, where an escaping error rolls
// the whole plan back and a hang holds a write lock — so a missing,
// slow, or broken index costs a task its PRE-READ section and nothing
// more.

import { matchesGlob } from './core.mjs';

// How many symbols and files a single task row may carry. A row long
// enough to be worth skimming is the point; a 500-symbol row bloats
// every packet that reads it and gets skipped whole.
export const MAX_SYMBOLS = 40;
export const MAX_FILES = 30;

// Transitive-caller depth for the blast radius. Deep enough to reach
// past a task's own layer, shallow enough that a hub function doesn't
// pull in the repo.
export const CALLER_DEPTH = 3;

// Wall-clock budget for the whole walk, seed query and every caller
// call together. Spent, the walk returns whatever it has.
export const RESOLVE_TIMEOUT_MS = 10_000;

// How many seeds get a find_all_callers call. The seed set is already
// capped by the Cypher query's own LIMIT; this bounds the round trips.
const MAX_SEED_EXPANSIONS = 20;

// The kinds this module reads out of the index. Both carry name, path
// and start_line, which is the whole of what a symbol row holds.
const SYMBOL_KINDS = ['Function', 'Class'];

// A scope glob reduced to the literal directory prefix every path it
// matches must start with: segments up to the first one carrying a
// wildcard. `apps/{module}/**` has already had {module} filled by
// plan.mjs, so what arrives here is concrete. An empty prefix means the
// glob constrains nothing at the front and matches repo-wide.
export function globPrefix(glob) {
  const segments = String(glob).split('/');
  const literal = [];
  for (const segment of segments) {
    if (/[*?[]/.test(segment)) break;
    if (segment !== '') literal.push(segment);
  }
  return literal.join('/');
}

// The distinct prefixes a task's scope reduces to. A repo-wide prefix
// ('') absorbs the rest — matching inside it is matching anywhere.
function scopePrefixes(scopeGlobs) {
  const prefixes = new Set();
  for (const glob of scopeGlobs) {
    const prefix = globPrefix(glob);
    if (prefix === '') return [''];
    prefixes.add(prefix);
  }
  return [...prefixes];
}

// task.scope_globs is stored as a JSON string (plan.mjs#layerTaskFields).
// A row written by hand, or by an older compile, may hold something
// else — a parse failure is a task with no resolvable scope, not an
// error worth aborting a plan run for.
function parseScopeGlobs(task) {
  try {
    const parsed = JSON.parse(task?.scope_globs ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g) => typeof g === 'string' && g !== '');
  } catch {
    return [];
  }
}

// Rejects the whole walk once the budget is spent. Racing each call
// against this bounds total wall clock rather than per-call latency, so
// twenty slow-but-finishing calls can't add up past the budget.
function withDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('code-intelligence timeout'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('code-intelligence timeout')), remaining);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Providers hand results back in whatever envelope their transport
// used — a bare array, or one wrapped under `results`/`records`/`data`.
// Anything else reads as no rows.
function rowsOf(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  for (const key of ['results', 'records', 'rows', 'data', 'nodes']) {
    if (Array.isArray(result[key])) return result[key];
  }
  return [];
}

// One graph node reduced to the symbol shape a task row stores. The
// node may arrive as the row itself or under a `node`/`symbol` key, and
// its kind may come from a label list rather than a field.
function toSymbol(row) {
  const node = row?.node ?? row?.symbol ?? row;
  if (!node || typeof node !== 'object') return null;

  const name = node.name ?? node.symbol ?? null;
  const path = node.path ?? node.file ?? node.file_path ?? null;
  if (typeof name !== 'string' || typeof path !== 'string') return null;

  const labels = Array.isArray(node.labels) ? node.labels : [];
  const kind =
    node.kind ?? labels.find((label) => SYMBOL_KINDS.includes(label)) ?? labels[0] ?? 'Symbol';

  const startLine = node.start_line ?? node.startLine ?? null;

  return {
    name,
    kind: String(kind),
    path,
    start_line: typeof startLine === 'number' ? startLine : null,
  };
}

// Seeds: every Function and Class the index has inside the task's own
// scope. Bound in the query rather than interpolated — `prefixes` comes
// off a task row, and the provider runs this against a live graph.
const SEED_CYPHER = `
  MATCH (f:File)-[:CONTAINS]->(s)
  WHERE (s:Function OR s:Class)
    AND any(prefix IN $prefixes WHERE prefix = '' OR f.path STARTS WITH prefix)
  RETURN s.name AS name, labels(s) AS labels, s.path AS path, s.start_line AS start_line
  LIMIT $limit
`;

// Resolves the symbols and files one task's scope reaches: the symbols
// declared inside its scope, plus the transitive callers of each — the
// blast radius a change inside that scope carries.
//
// Returns { symbols, files } — symbols as { name, kind, path,
// start_line }, files as repo-relative path strings, both capped — or
// null when there is no provider, no scope, no index content, or
// anything at all goes wrong.
export async function resolveTaskContext(task, provider) {
  if (!provider || typeof provider.execute_cypher_query !== 'function') return null;

  try {
    const deadline = Date.now() + RESOLVE_TIMEOUT_MS;

    const scopeGlobs = parseScopeGlobs(task);
    if (scopeGlobs.length === 0) return null;
    const prefixes = scopePrefixes(scopeGlobs);

    const seedResult = await withDeadline(
      provider.execute_cypher_query({
        cypher_query: SEED_CYPHER,
        params: { prefixes, limit: MAX_SYMBOLS },
      }),
      deadline,
    );

    // Keyed by name+path so the same symbol reached from two seeds
    // lands once; insertion order keeps the in-scope seeds ahead of
    // the callers they pulled in, which is the order the caps trim to.
    const symbols = new Map();
    const files = new Set();

    const remember = (row) => {
      const symbol = toSymbol(row);
      if (!symbol) return null;
      const key = `${symbol.path}::${symbol.name}`;
      if (!symbols.has(key)) symbols.set(key, symbol);
      files.add(symbol.path);
      return symbol;
    };

    const seeds = [];
    for (const row of rowsOf(seedResult)) {
      const symbol = remember(row);
      if (symbol) seeds.push(symbol);
    }
    if (seeds.length === 0) return null;

    // Blast radius: one transitive-caller call per seed, each scoped by
    // the seed's own file so a common name resolves to the right symbol.
    if (typeof provider.analyze_code_relationships === 'function') {
      for (const seed of seeds.slice(0, MAX_SEED_EXPANSIONS)) {
        if (symbols.size >= MAX_SYMBOLS && files.size >= MAX_FILES) break;
        const callers = await withDeadline(
          provider.analyze_code_relationships({
            query_type: 'find_all_callers',
            target: seed.name,
            context: seed.path,
            depth: CALLER_DEPTH,
          }),
          deadline,
        );
        for (const row of rowsOf(callers)) remember(row);
      }
    }

    return {
      symbols: [...symbols.values()].slice(0, MAX_SYMBOLS),
      files: [...files].slice(0, MAX_FILES),
    };
  } catch {
    return null;
  }
}

// task.context_files is stored as a JSON array of repo-relative path
// strings (resolveTaskContext, above). A row written by hand, or by an
// older compile, may hold something else — a parse failure means no
// computed radius to check, not an error worth surfacing.
function parseContextFiles(task) {
  try {
    const parsed = JSON.parse(task?.context_files ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f) => typeof f === 'string' && f !== '');
  } catch {
    return [];
  }
}

// The declared radius a task's verify command is expected to cover:
// verify_radius when set, scope_globs otherwise — the same fallback
// conflict.mjs's verifyRadius(task) applies, kept in sync with it by
// hand since the two read different columns off the same row.
function declaredRadiusGlobs(task) {
  const source = task?.verify_radius ?? task?.scope_globs;
  try {
    const parsed = JSON.parse(source ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g) => typeof g === 'string' && g !== '');
  } catch {
    return [];
  }
}

// Advisory only — never called from a path that blocks or gates. The
// computed blast radius (context_files) against the declared radius
// (verify_radius, falling back to scope_globs): files the index says the
// task's code reaches that no declared glob covers. A wrong or stale
// answer here costs a reader one ignored suggestion, never a build.
//
// Returns [] when context_files is absent, unparseable, or empty — "no
// index available" and "index found nothing uncovered" read the same to
// a caller, which is correct: neither is ever worth blocking on.
export function radiusGaps(task) {
  const files = parseContextFiles(task);
  if (files.length === 0) return [];

  const globs = declaredRadiusGlobs(task);
  if (globs.length === 0) return files;

  return files.filter((file) => {
    const segments = file.split('/').filter((segment) => segment !== '');
    return !globs.some((glob) => matchesGlob(segments, glob));
  });
}
