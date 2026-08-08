#!/usr/bin/env node
// Lint over the shipped Golden Cores' verify commands, plus the regression
// fixture for the bugs it was written from.
//
// Run: node repro/core-verify-lint.mjs
//
// ── What went wrong ──────────────────────────────────────────────────
// src/golden-cores/full-stack-app/core.yaml shipped verify commands that
// could not run at all against the workspace the same directory ships:
//
//   1. `pnpm nx test db --testPathPattern={module}` (and five more like it).
//      `--testPathPattern` is a Jest flag. This core pins `vitest ~4.1.0`,
//      and Vitest's CLI parser rejects unknown options outright:
//        CACError: Unknown option `--testPathPattern`
//      Every one of those gates aborted before running a single test — a
//      gate that could never pass, whatever the code did.
//
//   2. `pnpm typecheck && pnpm nx run-many -t test` on the join layer.
//      The core's package.json defines exactly one script, `dev`:
//        ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "typecheck" not found
//
//   3. A bare `{module}` as the test filter. Vitest's positional filter is
//      a substring match against the whole test file path, so a module
//      named `card` also pulled in `src/board/use-board-cards.spec.ts` —
//      and a module named `list` hit `vitest list`, Vitest's
//      list-collected-tests subcommand, which prints the collected tests
//      and exits 0. That is a gate that cannot fail.
//
// Both (1) and (2) are decidable from the core definition alone — no
// workspace, no install, no network. That is what this file automates, so
// the next core that ships a verify command naming a flag or a script that
// does not exist fails here instead of on someone's first build.

import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoreYaml, validateCore } from '../src/db/core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORES_DIR = join(ROOT, 'src/golden-cores');

const failures = [];
const fail = (msg) => failures.push(msg);

// ── Flags that belong to Jest and do not exist in Vitest's CLI. Vitest
//    exits on the first unknown option, so any of these is a gate that can
//    never pass. ────────────────────────────────────────────────────────
const JEST_ONLY_FLAGS = [
  'testPathPattern',
  'testPathPatterns',
  'testPathIgnorePatterns',
  'runTestsByPath',
  'runInBand',
  'detectOpenHandles',
  'forceExit',
  'collectCoverageFrom',
  'moduleNameMapper',
  'setupFilesAfterEnv',
  'testMatch',
  'roots',
];

// ── `pnpm <word>` is a package.json script unless <word> is one of pnpm's
//    own subcommands or a binary from a declared dependency. ────────────
const PNPM_SUBCOMMANDS = new Set([
  'add', 'audit', 'bin', 'config', 'create', 'dedupe', 'deploy', 'dlx', 'env',
  'exec', 'fetch', 'i', 'import', 'init', 'install', 'licenses', 'link', 'list',
  'ls', 'outdated', 'pack', 'patch', 'prune', 'publish', 'rebuild', 'remove',
  'root', 'run', 'server', 'setup', 'start', 'store', 'test', 'unlink', 'update',
  'why', 'why-command',
]);

// ── Projects the core ships whose `nx test` target does not exist yet.
//    Each entry is a known-open defect, not a style exemption: the shipped
//    apps/api and apps/web carry no vitest config, so they have no `test`
//    target, and a verify naming `nx test api`/`nx test web` dies with
//    "Cannot find configuration for task api:test" no matter how the
//    filter is spelled. Fixing it means adding a vitest config, a spec,
//    and (for web) jsdom + @testing-library to the core — a core
//    regeneration, tracked separately. The lint fails if an entry here
//    becomes unnecessary, so the list cannot rot. ───────────────────────
const KNOWN_MISSING_TEST_TARGET = {
  'full-stack-app': ['api', 'web'],
};

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// Splits a verify command on shell operators into individual commands.
const splitCommands = (verify) =>
  verify
    .split(/&&|\|\||;|(?<!\|)\|(?!\|)/)
    .map((c) => c.trim())
    .filter(Boolean);

// ── Check 1: no Jest-only flag anywhere in a verify command. ───────────
function checkJestFlags(label, verify) {
  for (const flag of JEST_ONLY_FLAGS) {
    if (new RegExp(`--${flag}\\b`).test(verify)) {
      fail(
        `${label}: verify uses Jest-only flag \`--${flag}\` — this core runs Vitest, ` +
          `whose CLI exits with "CACError: Unknown option" before any test runs`,
      );
    }
  }
}

// ── Check 2: every `pnpm <script>` a verify names exists. ──────────────
function checkPnpmScripts(label, verify, pkg) {
  if (!pkg) return;
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  for (const command of splitCommands(verify)) {
    const tokens = command.split(/\s+/);
    if (tokens[0] !== 'pnpm') continue;
    // skip pnpm's own flags (`pnpm --filter x exec ...`)
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) i += 2;
    const name = tokens[i];
    if (!name || PNPM_SUBCOMMANDS.has(name) || deps.has(name)) continue;
    if (!scripts.has(name)) {
      fail(
        `${label}: verify runs \`pnpm ${name}\`, but the core's package.json defines no ` +
          `"${name}" script (has: ${[...scripts].join(', ') || 'none'})`,
      );
    }
  }
}

// ── Check 3: a {module} used as a test filter is path-anchored. ────────
//    A bare `{module}` token is a substring match against the whole test
//    file path; it must carry its layer's directory and a trailing slash.
function checkAnchoredFilter(label, verify) {
  for (const token of verify.split(/\s+/)) {
    if (!token.includes('{module}')) continue;
    if (token === '{module}') {
      fail(
        `${label}: verify passes a bare \`{module}\` as a test filter — Vitest matches it ` +
          `as a substring of the whole file path, so it also selects another module's files ` +
          `(and a module named "list" hits \`vitest list\`, which exits 0 without running ` +
          `anything). Anchor it on the layer's own directory, e.g. \`src/schema/{module}/\``,
      );
    } else if (token.startsWith('{module}/') || (token.includes('/') && !token.endsWith('/'))) {
      fail(
        `${label}: test-filter path \`${token}\` is not anchored on the layer's own directory ` +
          `with a trailing slash`,
      );
    }
  }
}

// ── Check 4: `nx test <project>` names a project with a test target. ───
async function checkNxTestTargets(coreName, coreDir, label, verify) {
  const shipped = new Map(); // project name -> project dir
  for (const group of ['apps', 'packages']) {
    const groupDir = join(coreDir, group);
    if (!(await exists(groupDir))) continue;
    for (const entry of await readdir(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(groupDir, entry.name, 'package.json');
      if (!(await exists(pkgPath))) continue;
      const { name } = JSON.parse(await readFile(pkgPath, 'utf8'));
      if (name) shipped.set(name, join(groupDir, entry.name));
    }
  }
  const allowed = new Set(KNOWN_MISSING_TEST_TARGET[coreName] ?? []);
  for (const m of verify.matchAll(/\bnx\s+test\s+([A-Za-z0-9@/._-]+)/g)) {
    const project = m[1];
    if (project.includes('{module}')) continue; // per-module project, generated later
    const dir = shipped.get(project);
    if (!dir) continue; // not shipped by the core (add-on or loop-created)
    const hasVitest = (
      await Promise.all(
        ['vitest.config.mts', 'vitest.config.ts', 'vitest.config.mjs', 'vitest.config.js'].map(
          (f) => exists(join(dir, f)),
        ),
      )
    ).some(Boolean);
    if (!hasVitest && !allowed.has(project)) {
      fail(
        `${label}: verify runs \`nx test ${project}\`, but the shipped ${project} project has ` +
          `no vitest config, so it has no \`test\` target ("Cannot find configuration for ` +
          `task ${project}:test")`,
      );
    }
    if (hasVitest && allowed.has(project)) {
      fail(
        `KNOWN_MISSING_TEST_TARGET["${coreName}"] still lists "${project}", but that project ` +
          `now ships a vitest config — drop the entry`,
      );
    }
  }
}

// ── Lint the shipped cores ────────────────────────────────────────────
const coreNames = (await readdir(CORES_DIR, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

for (const coreName of coreNames) {
  const coreDir = join(CORES_DIR, coreName);
  const core = parseCoreYaml(await readFile(join(coreDir, 'core.yaml'), 'utf8'));
  validateCore(core);

  const pkgPath = join(coreDir, 'package.json');
  const pkg = (await exists(pkgPath)) ? JSON.parse(await readFile(pkgPath, 'utf8')) : null;

  for (const layer of core.layers) {
    const label = `${coreName}/core.yaml layer "${layer.id}"`;
    checkJestFlags(label, layer.verify);
    checkPnpmScripts(label, layer.verify, pkg);
    checkAnchoredFilter(label, layer.verify);
    await checkNxTestTargets(coreName, coreDir, label, layer.verify);
  }
}

// ── Regression fixture: the exact strings that shipped in 4.0.3 must be
//    rejected by the checks above. Without this the lint could silently
//    stop detecting the bug it was written for. ─────────────────────────
const SHIPPED_4_0_3 = [
  ['schema', 'pnpm nx test db --testPathPattern={module}'],
  ['contract', 'pnpm nx test contracts --testPathPattern={module}'],
  ['controller', 'pnpm nx test api --testPathPattern={module}'],
  ['hook', 'pnpm nx test hooks --testPathPattern={module}'],
  [
    'screen',
    'pnpm nx test web --testPathPattern={module} && pnpm nx test mobile --testPathPattern={module}',
  ],
  ['join', 'pnpm typecheck && pnpm nx run-many -t test'],
];
const UNANCHORED = [['hook', 'pnpm nx test hooks -- {module}']];

{
  const fsaPkg = JSON.parse(
    await readFile(join(CORES_DIR, 'full-stack-app/package.json'), 'utf8'),
  );
  for (const [layerId, verify] of SHIPPED_4_0_3) {
    const before = failures.length;
    const label = `fixture "${layerId}"`;
    checkJestFlags(label, verify);
    checkPnpmScripts(label, verify, fsaPkg);
    if (failures.length === before) {
      fail(`regression fixture: shipped 4.0.3 ${layerId} verify was NOT detected: ${verify}`);
    } else {
      failures.length = before; // expected — discard
    }
  }
  for (const [layerId, verify] of UNANCHORED) {
    const before = failures.length;
    checkAnchoredFilter(`fixture "${layerId}"`, verify);
    if (failures.length === before) {
      fail(`regression fixture: unanchored {module} filter was NOT detected: ${verify}`);
    } else {
      failures.length = before;
    }
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} verify-command check(s) failed:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('');
  process.exit(1);
}
console.log(
  `ok — verify commands lint clean across ${coreNames.length} cores ` +
    `(${coreNames.join(', ')}), and the 4.0.3 regression fixture is still detected`,
);
