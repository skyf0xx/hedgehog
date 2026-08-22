#!/usr/bin/env node
// Bumps the npm-package version — package.json (and package-lock.json,
// via `npm version`) — together with src/hosts/gemini/gemini-extension.json,
// the per-project template copy of that same version number a consuming
// project's Gemini CLI install carries. CLAUDE.md's Releasing section
// names this pair; `npm version patch` alone only ever wrote the first.
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

const templatePath = join(ROOT, 'src/hosts/gemini/gemini-extension.json');
const templateJson = JSON.parse(await readFile(templatePath, 'utf8'));
templateJson.version = version;
await writeFile(templatePath, `${JSON.stringify(templateJson, null, 2)}\n`);

console.log(`  package.json -> ${version}`);
console.log(`  src/hosts/gemini/gemini-extension.json -> ${version}`);
console.log(`\nBumped to ${version}. Not committed — review and commit by hand.`);
