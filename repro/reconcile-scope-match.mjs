// `hedgehog reconcile` and `hedgehog fast-path` judge scope with the same
// glob syntax the `hedgehog verify` gate does.
//
// verify.mjs hands a task's scope globs to git as `:(glob)…` pathspecs
// and lets git decide what is in scope. reconcile.mjs and fastpath.mjs
// cannot: their paths already came out of `git log --name-only` or
// `git status`, and re-asking git per task per commit would be one
// subprocess per pair. Both match in-process through core.mjs's
// pathInScope instead — so the syntax has to be git's, or a task's
// evidence would be gathered against a different scope than its gate
// enforces.
//
// The rules that differ between glob dialects, asserted here:
//   - `**` spans separators; a single `*` and `?` never do
//   - a trailing `/**` also matches the directory it names
//   - `[...]` is a character class
//   - every other character is a literal, `.` included
//
// The bracket cases are also checked against git's own `:(glob)` match.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathInScope } from '../src/db/core.mjs';
import { check, report } from './_lib.mjs';

const CASES = [
  // `**` spans separators.
  ['libs/alpha/schema/model.txt', ['libs/alpha/schema/**'], true],
  ['libs/alpha/schema/deep/nested/model.txt', ['libs/alpha/schema/**'], true],
  ['src/x/y.ts', ['**/*.ts'], true],
  ['y.ts', ['**/*.ts'], true],
  ['a/x/y/b.txt', ['a/**/b.txt'], true],
  ['a/b.txt', ['a/**/b.txt'], true],

  // A trailing `/**` also matches the directory itself, so a glob and the
  // directory it names agree.
  ['libs/alpha/schema', ['libs/alpha/schema/**'], true],

  // A single `*` and `?` stay inside one segment.
  ['src/alpha/schema.txt', ['src/*/schema.txt'], true],
  ['src/alpha/deep/schema.txt', ['src/*/schema.txt'], false],
  ['a.txt', ['*.txt'], true],
  ['dir/a.txt', ['*.txt'], false],

  // A prefix that is not a path prefix does not match.
  ['libs/alpha/schemax/model.txt', ['libs/alpha/schema/**'], false],
  ['libs/alpha/schemax', ['libs/alpha/schema/**'], false],
  ['libs/beta/schema/model.txt', ['libs/alpha/schema/**'], false],

  // Regex metacharacters in a glob are literals.
  ['a.b.txt', ['a.b.txt'], true],
  ['axbxtxt', ['a.b.txt'], false],
  ['x+y.ts', ['x+y.ts'], true],

  // `[...]` is a character class.
  ['src/a1.ts', ['src/[ab]1.ts'], true],
  ['src/b1.ts', ['src/[ab]1.ts'], true],
  ['src/c1.ts', ['src/[ab]1.ts'], false],

  // Any one glob in the list matching is enough.
  ['apps/api/orders/route.ts', ['libs/orders/**', 'apps/api/orders/**'], true],
  ['apps/web/page.tsx', ['libs/orders/**', 'apps/api/orders/**'], false],
];

for (const [path, globs, expected] of CASES) {
  check(`${path}  vs  ${globs.join(', ')}`, expected, pathInScope(path, globs));
}

const BRACKET_GLOB = 'src/[ab]1.ts';
const BRACKET_FILES = ['src/a1.ts', 'src/b1.ts', 'src/c1.ts'];
const repo = mkdtempSync(join(tmpdir(), 'hedgehog-glob-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  for (const file of BRACKET_FILES) {
    mkdirSync(join(repo, dirname(file)), { recursive: true });
    writeFileSync(join(repo, file), '');
  }
  execFileSync('git', ['add', '-A'], { cwd: repo });
  const byGit = execFileSync('git', ['ls-files', '--', `:(glob)${BRACKET_GLOB}`], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
  const inProcess = BRACKET_FILES.filter((file) => pathInScope(file, [BRACKET_GLOB])).sort();
  check(`${BRACKET_GLOB} selects the same files as git's :(glob)`, byGit.join(', '), inProcess.join(', '));
} finally {
  rmSync(repo, { recursive: true, force: true });
}

report("reconcile's and fast-path's scope match implement the same glob syntax the verify gate does");
