#!/usr/bin/env node
// Repro: the boundary harness captured stderr through a shell redirect,
// so a path containing $(...) ran it.
//
// runCliCapturingBoth needs stdout and stderr separately — `hedgehog
// boundary` puts different things on each — and used to get them by
// building `<node> <cli> <args> 2><errPath>` as a shell string, escaping
// every part with JSON.stringify.
//
// JSON.stringify is not a shell escape. It quotes and backslash-escapes,
// but inside double quotes `sh` still expands $(...) and backticks, so
// the quoting that looks defensive changes nothing about substitution.
// 7450c84 moved the CLI off shell-strung git for exactly this, and #14
// was blocked before merge for reintroducing it via
// JSON.stringify(commitMessage). This is the third instance of the same
// pattern in this repo, and the first in test code.
//
// The path here is not attacker-supplied in normal use — it comes from
// mkdtempSync under TMPDIR. It becomes reachable when TMPDIR, or the
// checkout directory a CI runner picks, contains shell metacharacters.
// The severity is low; the pattern is the point, and a helper that runs
// in CI should not be the place it survives.
//
// This proves the premise against the real /bin/sh first rather than
// asserting it, then pins the replacement: no substitution, the literal
// name used as a filename, and both streams still separated.
//
// Run: node repro/boundary-capture-no-shell.mjs

import { execFileSync, execSync } from 'node:child_process';
import {
  openSync,
  closeSync,
  existsSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected: ${expected}\n        actual:   ${actual}`);
};

const dir = mkdtempSync(join(tmpdir(), 'hedgehog-repro-noshell-'));
const MARKER = join(dir, 'SUBSTITUTED');

// No slashes anywhere in the payload: it has to stay a single legal
// filename, so that what this measures is substitution and not a
// missing parent directory. The `touch` target is therefore relative,
// which resolves against `cwd: dir` below.
const EVIL = 'err$(touch SUBSTITUTED)X.txt';
const evilPath = join(dir, EVIL);

console.log('1. premise: JSON.stringify does not stop command substitution in sh');
try {
  execSync(
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify('console.error(1)')} 2>${JSON.stringify(evilPath)}`,
    { cwd: dir, encoding: 'utf8', stdio: 'pipe' },
  );
} catch {
  // The redirect target is nonsense after substitution; the exit status
  // is not what this asserts.
}
check('the old construction executed the embedded command', existsSync(MARKER), true);
rmSync(MARKER, { force: true });

console.log('');
console.log('2. the replacement: execFileSync with stderr on a file descriptor');
const fd = openSync(evilPath, 'w');
let stdout = '';
try {
  stdout = execFileSync(
    process.execPath,
    ['-e', 'console.error("on-stderr"); console.log("on-stdout")'],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', fd] },
  );
} finally {
  closeSync(fd);
}

check('nothing was substituted', existsSync(MARKER), false);
check('the metacharacters stayed a literal filename', existsSync(evilPath), true);
check('stderr was captured', readFileSync(evilPath, 'utf8').trim(), 'on-stderr');
check('stdout stayed separate', stdout.trim(), 'on-stdout');

console.log('');
console.log('3. the helper itself, driven through a poisoned TMPDIR');

// The capture path is not a parameter — it comes from mkdtempSync under
// TMPDIR — so the way to reach it is the way a CI runner would: a temp
// directory whose own name carries the metacharacters. Sections 1 and 2
// pin the technique; this one guards runCliCapturingBoth, so reverting
// it to a shell string fails here rather than only in review.
//
// TMPDIR has to be set on THIS process, not passed as the helper's
// `env`: os.tmpdir() reads the current process's environment, and the
// `env` option only reaches the child. Passing it there instead makes
// every assertion below pass against the unfixed helper — checked, and
// it is the reason this section is written the way it is.
const POISON_PARENT = join(dir, 'tmp$(touch ESCAPED)root');
mkdirSync(POISON_PARENT, { recursive: true });
const priorTmpdir = process.env.TMPDIR;
process.env.TMPDIR = POISON_PARENT;

const { runCliCapturingBoth } = await import('./lib/fixture.mjs');
const project = mkdtempSync(join(dir, 'project-'));

// The substituted command inherits the child's cwd, which the helper
// sets to the project — so that, not TMPDIR, is where the marker lands.
const escapedMarker = join(project, 'ESCAPED');

let result;
try {
  result = runCliCapturingBoth(project, ['boundary']);
} finally {
  if (priorTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = priorTmpdir;
}

check('the helper did not substitute through its capture path', existsSync(escapedMarker), false);
check(
  'the helper still returned both streams',
  typeof result.stdout === 'string' && typeof result.stderr === 'string',
  true,
);

rmSync(dir, { recursive: true, force: true });

console.log('');
if (failures > 0) {
  console.log(`FAIL  boundary capture runs through a shell — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('PASS  boundary capture takes no shell, and still separates the streams');
