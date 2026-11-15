#!/usr/bin/env node
// Repro: HEDGEHOG_CORE_SOURCE resolves a core checkout by `hedgehog-core-<name>`
// first, then by the package's last path segment.
//
// Run: node repro/core-source-checkout-key.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, finish, REPO_ROOT } from './papercuts-lib.mjs';

console.log('repro: core-source-checkout-key');

const engineMajor = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version.split('.')[0];
const entry = { name: 'copywriting', package: '@skyf0xx/hedgehog-core-copywriting-prose-engineering', version: '0.x' };
const source = mkdtempSync(join(tmpdir(), 'hedgehog-core-key-'));

function checkout(dirName, version) {
  const root = join(source, dirName);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: entry.package, version }));
  writeFileSync(join(root, 'hedgehog-core.yaml'), `name: copywriting\nengine: "^${engineMajor}.0.0"\ntemplate: CLAUDE.core.md\n`);
  writeFileSync(join(root, 'CLAUDE.core.md'), 'core\n');
}

process.env.HEDGEHOG_CORE_SOURCE = source;
process.env.HEDGEHOG_CORE_NO_CACHE = '1';
const { fetchCore } = await import('../src/registry/fetch.mjs');

try {
  checkout('hedgehog-core-copywriting', '0.0.1-byname');
  const byName = await fetchCore(entry);
  check('core-name directory resolves', byName.version === '0.0.1-byname', { expected: '0.0.1-byname', actual: byName.version });

  checkout('hedgehog-core-copywriting-prose-engineering', '0.0.1-bybasename');
  const both = await fetchCore(entry);
  check('core-name directory wins over the package basename', both.version === '0.0.1-byname', { expected: '0.0.1-byname', actual: both.version });

  rmSync(join(source, 'hedgehog-core-copywriting'), { recursive: true });
  const basename = await fetchCore(entry);
  check('package basename directory still resolves', basename.version === '0.0.1-bybasename', { expected: '0.0.1-bybasename', actual: basename.version });
} finally {
  rmSync(source, { recursive: true, force: true });
}

finish('core-source-checkout-key');
