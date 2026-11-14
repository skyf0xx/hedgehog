#!/usr/bin/env node
// Repro: `hedgehog core check [path]` and `hedgehog core show [--json]`.
//
// Asserts:
//   1. `core check <path>` passes a valid fixture and exits 1 on one whose
//      layer has no verify, naming the error;
//   2. `core check` with no path checks the project's own core, and
//      exits 1 when the project has none;
//   3. `core show` reads a root core.yaml, and `.hedgehog/core.yaml` when
//      that exists (the same precedence every other command uses), in
//      both text and --json form;
//   4. neither command creates a build graph.
//
// Run: node repro/core-check-and-show.mjs

import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, checkContains, finish, hedgehog, REPO_ROOT } from './papercuts-lib.mjs';

console.log('repro: core-check-and-show');

const FIXTURES = join(REPO_ROOT, 'repro/fixtures/core-check');
const VALID = join(FIXTURES, 'valid.core.yaml');
const BROKEN = join(FIXTURES, 'missing-verify.core.yaml');
const LANDING = join(REPO_ROOT, 'repro/fixtures/cores/landing-page.core.yaml');

const dir = mkdtempSync(join(tmpdir(), 'hedgehog-core-check-'));
const noGraph = (label) =>
  check(`${label}: no build graph created`, !existsSync(join(dir, '.hedgehog/hedgehog.db')), {
    expected: 'no .hedgehog/hedgehog.db',
    actual: 'graph created',
  });

try {
  // ── 1. explicit paths ─────────────────────────────────────────────────
  const valid = hedgehog(dir, ['core', 'check', VALID]);
  check('valid fixture passes', valid.status === 0, { expected: 'exit 0', actual: `${valid.status}\n${valid.all}` });
  checkContains('valid fixture reports valid', valid.all, 'valid');

  const broken = hedgehog(dir, ['core', 'check', BROKEN]);
  check('broken fixture fails', broken.status === 1, { expected: 'exit 1', actual: `${broken.status}\n${broken.all}` });
  checkContains('broken fixture names the error', broken.all, 'missing verify');

  // ── 2. default path ───────────────────────────────────────────────────
  const none = hedgehog(dir, ['core', 'check']);
  check('no core: check fails', none.status === 1, { expected: 'exit 1', actual: `${none.status}\n${none.all}` });
  checkContains('no core: says so', none.all, 'No core definition found');

  copyFileSync(LANDING, join(dir, 'core.yaml'));
  const rootCheck = hedgehog(dir, ['core', 'check']);
  check('root core.yaml: check passes', rootCheck.status === 0, { expected: 'exit 0', actual: `${rootCheck.status}\n${rootCheck.all}` });
  checkContains('root core.yaml: check names it', rootCheck.all, 'core.yaml');

  // ── 3. show, root then authored ───────────────────────────────────────
  const rootShow = hedgehog(dir, ['core', 'show']);
  check('root core.yaml: show exits 0', rootShow.status === 0, { expected: 'exit 0', actual: `${rootShow.status}\n${rootShow.all}` });
  checkContains('root core.yaml: show names the core', rootShow.all, 'landing-page');
  checkContains('root core.yaml: show prints verify', rootShow.all, 'test -s .hedgehog/chain/00-brief.md');

  const rootJson = JSON.parse(hedgehog(dir, ['core', 'show', '--json']).stdout);
  check('root --json: path', rootJson.path === 'core.yaml', { expected: 'core.yaml', actual: rootJson.path });
  check('root --json: id and pattern', rootJson.id === 'landing-page' && rootJson.pattern === 'layered', {
    expected: 'landing-page / layered',
    actual: `${rootJson.id} / ${rootJson.pattern}`,
  });
  const first = rootJson.layers[0];
  check(
    'root --json: layer fields',
    first.id === 'brief' &&
      first.depends_on === null &&
      Array.isArray(first.scope) &&
      first.verify_radius === null &&
      first.exclusive === false &&
      first.commit === 'chore(planning): intake',
    { expected: 'brief layer with every field', actual: JSON.stringify(first) },
  );

  mkdirSync(join(dir, '.hedgehog'), { recursive: true });
  copyFileSync(VALID, join(dir, '.hedgehog/core.yaml'));
  const authoredJson = JSON.parse(hedgehog(dir, ['core', 'show', '--json']).stdout);
  check('authored --json: .hedgehog/core.yaml wins', authoredJson.path === '.hedgehog/core.yaml', {
    expected: '.hedgehog/core.yaml',
    actual: authoredJson.path,
  });
  const api = authoredJson.layers.find((l) => l.id === 'api');
  check(
    'authored --json: depends_on, radius, exclusive',
    api?.depends_on === 'schema' && api.verify_radius?.length === 2 && api.exclusive === true,
    { expected: 'api depends on schema, 2 radius globs, exclusive', actual: JSON.stringify(api) },
  );
  const authoredShow = hedgehog(dir, ['core', 'show']);
  checkContains('authored text: names the core', authoredShow.all, 'check-fixture');
  checkContains('authored text: names the path', authoredShow.all, '.hedgehog/core.yaml');

  noGraph('check and show');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

finish('core-check-and-show');
