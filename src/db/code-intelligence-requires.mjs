// Whether this project can actually run code intelligence (CodeGraphContext,
// "CGC"), checked once, at `init`, before there is anything else to fall
// back to.
//
// This is a different contract than requires.mjs: that module is advisory
// and per-core-declared (a layer names binaries its own verify command
// needs); this one is engine-declared and blocking (every Hedgehog project
// needs Python and CGC, full stop). Kept in a separate file rather than
// merged in so the two contracts stay visibly distinct.
//
// No side effects anywhere here: no printing, no installing, no process
// exit, no writes. `checkCodeIntelligence` only looks and reports; a caller
// decides what to do with the answer.

import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findBinary } from './requires.mjs';

// CGC's documented floor. One source of truth: both the version check
// below and anything describing the requirement read this rather than a
// hardcoded "3.10" living in two places.
export const MIN_PYTHON = { major: 3, minor: 10 };

// Resolves the Python 3 interpreter the verify/setup shell would find:
// `python3` first, and `python` only once confirmed to actually be
// Python 3 — some systems alias `python` to Python 2, and some have
// no `python` at all. Returns the resolved path or null.
export function findPython3(env = process.env) {
  const python3 = findBinary('python3', env);
  if (python3) return python3;

  const python = findBinary('python', env);
  if (!python) return null;

  const version = pythonVersion(python);
  return version && version.major === 3 ? python : null;
}

// Reads `sys.version_info` from the interpreter directly, rather than
// parsing `--version` output (whose format has varied across Python
// releases and isn't meant as a stable interface). Returns
// `{ major, minor }` or null if the binary can't be run or doesn't
// print what's expected.
export function pythonVersion(pythonPath) {
  try {
    const output = execFileSync(
      pythonPath,
      ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'],
      { encoding: 'utf8' }
    ).trim();
    const [major, minor] = output.split('.').map(Number);
    if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
    return { major, minor };
  } catch {
    return null;
  }
}

// Resolves a CodeGraphContext binary on PATH, trying the full name first
// and its documented shorthand second.
export function findCodeGraphContext(env = process.env) {
  return findBinary('codegraphcontext', env) ?? findBinary('cgc', env);
}

// Reads and validates `.hedgehog/code-intelligence.json` under `cwd`,
// matching the shape `loadCodeIntelligenceConfig()` in bin/cli.mjs
// expects: an object with a non-empty string `command`. Returns the
// parsed config or null — absent, unreadable, and malformed all collapse
// to the same null, matching that function's own handling.
async function loadConfig(cwd) {
  try {
    const raw = await readFile(join(cwd, '.hedgehog', 'code-intelligence.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.command !== 'string' || parsed.command === '') return null;
    return parsed;
  } catch {
    return null;
  }
}

// Whether `command` names a file this process can actually execute.
// Config carrying a path that no longer resolves is the "install broke
// after the fact" case, which reads as a missing CGC rather than a
// missing config.
function isExecutable(command) {
  if (typeof command !== 'string' || command === '') return false;
  try {
    accessSync(command, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The single entry point. Checks python presence, python version, CGC
// presence, and config presence, in that order, so the result names the
// *first* real blocker — reporting a missing config to someone who has no
// Python yet sends them down the wrong path. No side effects: this only
// looks and reports.
//
// Returns `{ ok: true, pythonPath, pythonVersion, cgcPath, config }` when
// every check passes, or `{ ok: false, reason, detail }` where `reason` is
// one of `'missing-python' | 'python-too-old' | 'missing-cgc' |
// 'missing-config'` and `detail` carries whatever's useful for the
// reason (the version found, for instance).
export async function checkCodeIntelligence({ env = process.env, cwd = process.cwd() } = {}) {
  const pythonPath = findPython3(env);
  if (!pythonPath) {
    return { ok: false, reason: 'missing-python', detail: null };
  }

  const version = pythonVersion(pythonPath);
  if (
    !version ||
    version.major !== MIN_PYTHON.major ||
    version.minor < MIN_PYTHON.minor
  ) {
    return { ok: false, reason: 'python-too-old', detail: { pythonPath, version } };
  }

  // The config's own `command` is the authoritative answer, and PATH is
  // only the fallback for finding CGC without one. Setup installs into a
  // project-owned environment and records an absolute path there, exactly
  // so the interpreter the user's other tools rely on stays untouched —
  // requiring a PATH hit as well would make that correct install fail
  // this check unless the user also edited their shell profile.
  const config = await loadConfig(cwd);
  const configuredPath = config && isExecutable(config.command) ? config.command : null;
  const cgcPath = configuredPath ?? findCodeGraphContext(env);
  if (!cgcPath) {
    return { ok: false, reason: 'missing-cgc', detail: { pythonPath, version } };
  }

  if (!config) {
    return { ok: false, reason: 'missing-config', detail: { pythonPath, version, cgcPath } };
  }

  return { ok: true, pythonPath, pythonVersion: version, cgcPath, config };
}

// Renders checkCodeIntelligence()'s failing result as printable lines,
// mirroring formatMissingRequirements's shape and style. This is the
// single owning source for this copy — the CLI, the setup skill, the
// update/status notice, and the README all render from this rather than
// restating it.
//
// Leads with the payoff, not the requirement: what a user gets is an
// agent that starts each task with the symbols and files it actually
// needs already loaded instead of searching for them, so tasks cost
// fewer tokens and finish faster, plus declared verify_radius gaps get
// flagged against the real blast radius before they bite.
export function formatCodeIntelligenceGap(result) {
  if (!result || result.ok) return [];

  const lines = [
    'CODE INTELLIGENCE NOT SET UP',
    '',
    '  With it, tasks start with the symbols and files they actually need',
    '  already loaded instead of searching for them — fewer tokens burned',
    '  per task, faster runs — and verify_radius gaps get flagged against',
    '  the real blast radius.',
    '',
  ];

  switch (result.reason) {
    case 'missing-python':
      lines.push(`  Python ${MIN_PYTHON.major}.${MIN_PYTHON.minor}+ was not found on PATH.`);
      break;
    case 'python-too-old': {
      const found = result.detail?.version
        ? `${result.detail.version.major}.${result.detail.version.minor}`
        : 'an older version';
      lines.push(
        `  Found Python ${found}, but ${MIN_PYTHON.major}.${MIN_PYTHON.minor}+ is required.`
      );
      break;
    }
    case 'missing-cgc':
      lines.push('  CodeGraphContext (codegraphcontext / cgc) was not found on PATH.');
      break;
    case 'missing-config':
      lines.push('  .hedgehog/code-intelligence.json is missing or unreadable.');
      break;
    default:
      lines.push('  Code intelligence is not usable yet.');
  }

  lines.push('');
  lines.push('  Run the hedgehog-code-intelligence-setup skill to set it up.');
  return lines;
}

// ---------------------------------------------------------------------------
// Index freshness
// ---------------------------------------------------------------------------
//
// The install check above answers "can CGC run here". This answers the
// separate question "does the index still describe this code" — a working
// CGC whose graph was built ten commits ago passes every check above and
// still feeds `plan` a picture of code that no longer exists.
//
// The index carries the commit it was built from, so the claim is
// checkable. That is the whole mechanism: an index that knows which commit
// it describes is a cache, and one that doesn't is a second source of
// truth quietly drifting from the first.

// Reads HEAD without requiring a git binary lookup through findBinary:
// `git` is already a hard requirement everywhere else in this CLI. Returns
// the full SHA, or null outside a repository or on any git failure —
// callers treat null as "can't tell", never as "stale".
export function headSha(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

// Whether the index the config describes still matches HEAD.
//
// Returns one of:
//   { state: 'fresh',   indexedSha, head }
//   { state: 'stale',   indexedSha, head }
//   { state: 'unknown', reason }
//
// `unknown` is the honest answer in three distinct cases, and none of them
// are failures: a config written before this field existed ('no-provenance'),
// a non-repository or unreadable git ('no-head'), and an absent config
// ('no-config'). A caller that can't tell says so rather than guessing;
// nothing here ever blocks.
export async function checkIndexFreshness({ cwd = process.cwd() } = {}) {
  const config = await loadConfig(cwd);
  if (!config) return { state: 'unknown', reason: 'no-config' };

  const indexedSha = typeof config.indexedSha === 'string' && config.indexedSha !== ''
    ? config.indexedSha
    : null;
  if (!indexedSha) return { state: 'unknown', reason: 'no-provenance' };

  const head = headSha(cwd);
  if (!head) return { state: 'unknown', reason: 'no-head' };

  return { state: indexedSha === head ? 'fresh' : 'stale', indexedSha, head };
}

// Renders a non-fresh freshness result as printable lines, in the same
// owning-source spirit as formatCodeIntelligenceGap: `plan`, `status`, and
// `next` all render from here rather than restating the copy.
//
// Returns [] for a fresh index and for 'no-config' — a project that never
// set code intelligence up is not a project with a stale index, and gets
// the setup gap message instead. The other two unknowns do print: an index
// with no recorded commit is exactly the drift this check exists to end.
export function formatIndexStaleness(result, { indexCommand = 'cgc index .' } = {}) {
  if (!result || result.state === 'fresh') return [];
  if (result.state === 'unknown' && result.reason === 'no-config') return [];

  if (result.state === 'unknown') {
    return [
      'CODE INTELLIGENCE INDEX AGE UNKNOWN',
      '',
      result.reason === 'no-provenance'
        ? '  The index does not record which commit it was built from, so'
        : '  HEAD could not be read, so',
      '  whether it still matches this code cannot be checked.',
      '',
      `  Re-index to establish it: ${indexCommand}`,
    ];
  }

  return [
    'CODE INTELLIGENCE INDEX IS STALE',
    '',
    `  Indexed at ${result.indexedSha.slice(0, 8)}, HEAD is ${result.head.slice(0, 8)}.`,
    '  Pre-read context and verify_radius suggestions are drawn from code',
    '  as it was, so they may name symbols that moved and miss ones added.',
    '',
    `  Refresh it: ${indexCommand}`,
  ];
}
