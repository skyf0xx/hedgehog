// `hedgehog reconcile`'s scope comparison agrees with the gate
// `hedgehog verify` runs.
//
// verify.mjs hands a task's scope globs to git as `:(glob)…` pathspecs
// and lets git decide what is in scope. reconcile.mjs cannot: its paths
// already came out of `git log --name-only`, and re-asking git per task
// per commit would be one subprocess per pair. It matches in-process
// instead — so the syntax has to be the same syntax, or a task's evidence
// would be gathered against a different scope than its gate enforces.
//
// The three rules that differ between glob dialects, asserted here:
//   - `**` spans separators; a single `*` and `?` never do
//   - a trailing `/**` also matches the directory it names
//   - every other character is a literal, `.` included

import { pathInScope } from '../src/db/reconcile.mjs';
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

  // Any one glob in the list matching is enough.
  ['apps/api/orders/route.ts', ['libs/orders/**', 'apps/api/orders/**'], true],
  ['apps/web/page.tsx', ['libs/orders/**', 'apps/api/orders/**'], false],
];

for (const [path, globs, expected] of CASES) {
  check(`${path}  vs  ${globs.join(', ')}`, expected, pathInScope(path, globs));
}

report("reconcile's scope match implements the same glob syntax the verify gate does");
