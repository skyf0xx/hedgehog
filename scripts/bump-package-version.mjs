#!/usr/bin/env node
// Bumps Hedgehog's one version number everywhere it's carried:
// package.json (and package-lock.json, via `npm version`),
// src/hosts/gemini/gemini-extension.json (the per-project template copy
// a consuming project's Gemini CLI install carries), and the plugin
// family — .claude-plugin/plugin.json, .claude-plugin/marketplace.json's
// plugins[0].version, .cursor-plugin/plugin.json, and root
// gemini-extension.json (the Claude Code/Cursor/Gemini CLI packagings of
// the skills/ + hooks/ payload). CLAUDE.md's Releasing section names all
// six files as one family sharing one version.
//
// Run with `npm run release` (patch) or `npm run release -- <bump>` for
// any bump `npm version` accepts (minor, major, or an explicit x.y.z).

import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const bump = process.argv[2] || 'patch';

const output = execFileSync('npm', ['version', bump, '--no-git-tag-version'], {
  cwd: ROOT,
  encoding: 'utf8',
});
const version = output.trim().replace(/^v/, '');

const FILES = [
  {
    path: 'src/hosts/gemini/gemini-extension.json',
    get: (j) => j.version,
    set: (j, v) => { j.version = v; },
  },
  { path: '.claude-plugin/plugin.json', get: (j) => j.version, set: (j, v) => { j.version = v; } },
  {
    path: '.claude-plugin/marketplace.json',
    get: (j) => j.plugins?.[0]?.version,
    set: (j, v) => { j.plugins[0].version = v; },
  },
  { path: '.cursor-plugin/plugin.json', get: (j) => j.version, set: (j, v) => { j.version = v; } },
  { path: 'gemini-extension.json', get: (j) => j.version, set: (j, v) => { j.version = v; } },
];

console.log(`  package.json -> ${version}`);
for (const f of FILES) {
  const fullPath = join(ROOT, f.path);
  const json = JSON.parse(await readFile(fullPath, 'utf8'));
  f.set(json, version);
  await writeFile(fullPath, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`  ${f.path} -> ${version}`);
}

console.log(`\nBumped to ${version}. Not committed — review and commit by hand.`);
