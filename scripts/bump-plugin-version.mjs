#!/usr/bin/env node
// Bumps the plugin-family version — .claude-plugin/plugin.json,
// .claude-plugin/marketplace.json's plugins[0].version,
// .cursor-plugin/plugin.json, and root gemini-extension.json — together,
// the four manifests of the same skills/ + hooks/ payload named in
// CLAUDE.md's Releasing section. Refuses to touch
// src/hosts/gemini/gemini-extension.json, unrelated per-project template
// content that sits outside this family on purpose.
//
// Run with `npm run release:plugin` (defaults to a patch bump), or
// `npm run release:plugin -- <major|minor|patch|x.y.z>`. Asserts the four
// files agree on their current version before writing, so a prior silent
// drift (a file missed on an earlier bump) surfaces here instead of
// compounding.

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const arg = process.argv[2] || 'patch';

function nextVersion(current, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [major, minor, patch] = current.split('.').map(Number);
  if (spec === 'major') return `${major + 1}.0.0`;
  if (spec === 'minor') return `${major}.${minor + 1}.0`;
  if (spec === 'patch') return `${major}.${minor}.${patch + 1}`;
  console.error(`Usage: npm run release:plugin -- <major|minor|patch|x.y.z>  (e.g. 5.2.0)`);
  process.exit(1);
}

const FILES = [
  { path: '.claude-plugin/plugin.json', get: (j) => j.version, set: (j, v) => { j.version = v; } },
  {
    path: '.claude-plugin/marketplace.json',
    get: (j) => j.plugins?.[0]?.version,
    set: (j, v) => { j.plugins[0].version = v; },
  },
  { path: '.cursor-plugin/plugin.json', get: (j) => j.version, set: (j, v) => { j.version = v; } },
  { path: 'gemini-extension.json', get: (j) => j.version, set: (j, v) => { j.version = v; } },
];

const loaded = await Promise.all(
  FILES.map(async (f) => ({
    ...f,
    fullPath: join(ROOT, f.path),
    json: JSON.parse(await readFile(join(ROOT, f.path), 'utf8')),
  })),
);

const current = new Set(loaded.map((f) => f.get(f.json)));
if (current.size > 1) {
  console.error(
    `Plugin-family files disagree before bumping — fix drift first:\n${loaded
      .map((f) => `  ${f.path}: ${f.get(f.json)}`)
      .join('\n')}`,
  );
  process.exit(1);
}

const target = nextVersion([...current][0], arg);

for (const f of loaded) {
  f.set(f.json, target);
  await writeFile(f.fullPath, `${JSON.stringify(f.json, null, 2)}\n`);
  console.log(`  ${f.path} -> ${target}`);
}

console.log(`\nBumped plugin family to ${target}. Not committed — review and commit by hand.`);
