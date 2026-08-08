#!/usr/bin/env node
// Reproduction for the quoted-scalar escape bug in src/db/core.mjs.
//
// The core-definition parser is hand-rolled (the package ships no YAML
// dependency). Its `parseScalar` recognised a quoted scalar by its first
// and last character and then returned `s.slice(1, -1)` — the quotes came
// off, but the escape sequences inside never did. A `verify` command
// written with escaped quotes therefore loaded, validated, and appeared
// correct in every listing, while the string actually handed to the shell
// still carried literal backslashes.
//
// The method that found it, and the method used here: assert against the
// string the parser RETURNS, not the string as written in the file. The
// two look identical in a YAML listing and are not the same string.
//
// No test framework is available. Plain assertions, expected-vs-actual on
// failure, non-zero exit if anything fails.
//
// Run: node repro/yaml-scalar-escapes.mjs

import { execFileSync } from 'node:child_process';
import { parseCoreYaml } from '../src/db/core.mjs';

let failures = 0;
let passes = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passes++;
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`          expected: ${JSON.stringify(expected)}`);
    console.log(`          actual:   ${JSON.stringify(actual)}`);
  }
}

function checkThrows(name, fn) {
  try {
    const value = fn();
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`          expected: a thrown error`);
    console.log(`          actual:   returned ${JSON.stringify(value)}`);
  } catch {
    passes++;
    console.log(`  PASS  ${name}`);
  }
}

// Parses a one-layer core and hands back that layer. String.raw is used at
// every call site so the YAML in this file is byte-for-byte the YAML a core
// author would type.
function layerFrom(verify, commit = '"chore: demo"') {
  const yaml = [
    'id: demo',
    'layers:',
    '  - id: only',
    '    scope: [src/**]',
    `    verify: ${verify}`,
    `    commit: ${commit}`,
  ].join('\n');
  return parseCoreYaml(yaml).layers[0];
}

// ---------------------------------------------------------------------
console.log('\n1. escaped quotes in a double-quoted scalar (the reported bug)');
// In the file:  verify: "export PATH=\"$HOME/bin:$PATH\"; echo PATH=$PATH"
{
  const src = String.raw`"export PATH=\"$HOME/bin:$PATH\"; echo PATH=$PATH"`;
  check(
    'backslash-escaped quotes are unescaped',
    layerFrom(src).verify,
    'export PATH="$HOME/bin:$PATH"; echo PATH=$PATH',
  );
}

// ---------------------------------------------------------------------
console.log('\n2. the parsed string, run as a shell command');
// This is the check that exposed the bug: run what the parser returned,
// not what the file says. With the backslashes left in, sh sees \" as a
// literal quote character and the assignment's value carries parasitic
// quotes, producing an invalid PATH.
{
  const src = String.raw`"export PATH=\"$HOME/bin:$PATH\"; printf %s \"$PATH\""`;
  const verify = layerFrom(src).verify;
  let output;
  try {
    output = execFileSync('/bin/sh', ['-c', verify], {
      encoding: 'utf8',
      env: { HOME: '/home/u', PATH: '/usr/bin' },
    });
  } catch (error) {
    output = `<command failed: ${error.message}>`;
  }
  check('PATH built by the parsed command has no parasitic quotes', output, '/home/u/bin:/usr/bin');
}

// ---------------------------------------------------------------------
console.log('\n3. the rest of the double-quoted escape set');
{
  check('\\\\ becomes a single backslash', layerFrom(String.raw`"a\\b"`).verify, 'a\\b');
  check('\\n becomes a newline', layerFrom(String.raw`"a\nb"`).verify, 'a\nb');
  check('\\t becomes a tab', layerFrom(String.raw`"a\tb"`).verify, 'a\tb');
  check('\\r becomes a carriage return', layerFrom(String.raw`"a\rb"`).verify, 'a\rb');
  check('\\/ becomes a slash', layerFrom(String.raw`"a\/b"`).verify, 'a/b');
  check('\\0 becomes NUL', layerFrom(String.raw`"a\0b"`).verify, 'a\0b');
  check('\\xNN is a hex escape', layerFrom(String.raw`"a\x41b"`).verify, 'aAb');
  check(
    '\\uNNNN is a unicode escape',
    layerFrom('"a\\u00e9b"').verify,
    'aéb',
  );
  // A backslash that escapes nothing meaningful must be loud, never silent.
  checkThrows('an unknown escape is rejected', () => layerFrom(String.raw`"a\qb"`).verify);
  checkThrows('an unterminated double-quoted scalar is rejected', () =>
    layerFrom(String.raw`"a\"`).verify);
}

// ---------------------------------------------------------------------
console.log("\n4. single-quoted scalars ('' is YAML's escape for a quote)");
{
  check(
    "'' becomes one literal quote",
    layerFrom(`'echo it''s fine'`).verify,
    "echo it's fine",
  );
  check(
    'a backslash in a single-quoted scalar stays literal',
    layerFrom(`'grep -E "a\\d" .'`).verify,
    'grep -E "a\\d" .',
  );
  checkThrows('an unterminated single-quoted scalar is rejected', () =>
    layerFrom(`'abc`).verify);
}

// ---------------------------------------------------------------------
console.log('\n5. a # after an escaped quote is not a comment');
// stripComment tracked quote state without honouring backslashes, so the
// escaped quote read as the end of the string and everything from the
// following # onward was discarded as a comment — silently truncating the
// command.
{
  const src = String.raw`"echo \"tag#1\" && test -f a"`;
  check(
    'the value survives a # inside the quoted scalar',
    layerFrom(src).verify,
    'echo "tag#1" && test -f a',
  );
}

// ---------------------------------------------------------------------
console.log('\n6. no regression: ordinary scalars parse as before');
{
  const yaml = [
    '# a leading comment',
    'id: demo-core',
    'layers:',
    '  - id: schema',
    '    scope: [packages/db/src/schema/**, packages/db/src/index.ts]',
    '    verify: pnpm nx test db    # trailing comment',
    '    commit: "feat(schema): tables"',
    '    exclusive: true',
    '    verify_radius: [packages/db/**]',
    '  - id: api',
    "    depends_on: schema",
    '    scope: [apps/api/**]',
    "    verify: 'pnpm nx test api'",
    '    commit: feat(api): endpoints',
  ].join('\n');
  const core = parseCoreYaml(yaml);
  check('top-level id', core.id, 'demo-core');
  check('layer count', String(core.layers.length), '2');
  check('unquoted verify, comment stripped', core.layers[0].verify, 'pnpm nx test db');
  check('double-quoted commit', core.layers[0].commit, 'feat(schema): tables');
  check('inline list first entry', core.layers[0].scope[0], 'packages/db/src/schema/**');
  check('inline list second entry', core.layers[0].scope[1], 'packages/db/src/index.ts');
  check('exclusive flag', String(core.layers[0].exclusive), 'true');
  check('verify_radius', core.layers[0].verify_radius.join('|'), 'packages/db/**');
  check('depends_on', core.layers[1].depends_on, 'schema');
  check('single-quoted verify', core.layers[1].verify, 'pnpm nx test api');
  check('unquoted commit with a colon', core.layers[1].commit, 'feat(api): endpoints');
  check('default verify_radius is null', String(core.layers[1].verify_radius), 'null');
  check('default exclusive is false', String(core.layers[1].exclusive), 'false');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
