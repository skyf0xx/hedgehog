#!/usr/bin/env node
// Repro: the generated AGENTS.md indexes the installed core's agents and
// skills, and every emitted agent's tool grant comes from its own
// `tools:` frontmatter, including an agent the engine has never heard of.
//
// Network-free: the core package is built in a temp directory and
// resolved through HEDGEHOG_CORE_SOURCE, with HEDGEHOG_CORE_NO_CACHE set.
//
// Asserts:
//   1. `init --core <name>` on Cursor lists the core's agents and skills
//      in AGENTS.md, each agent with the grant its `tools:` states;
//   2. the emitted Cursor agent files restate those grants;
//   3. a coreless `init` on Gemini lists no core agent, and a later
//      `core install` adds them to AGENTS.md; `update` keeps them;
//   4. the engine's own rows are present in every case.
//
// Run: node repro/agents-md-lists-core.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { check, checkContains, finish, hedgehog, run, REPO_ROOT } from './papercuts-lib.mjs';
import { CAPABILITY_GRANT, capabilityFromTools } from '../src/hosts/capabilities.mjs';

console.log('repro: agents-md-lists-core');

const source = mkdtempSync(join(tmpdir(), 'hedgehog-agents-md-src-'));
const projects = [];

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const engineMajor = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version.split('.')[0];

// Agent names no engine file mentions, one per capability.
const AGENTS = {
  'widget-smith': { tools: 'Read, Glob, Grep, Edit, Write, Bash', cap: 'full' },
  'widget-auditor': { tools: 'Read, Glob, Grep, Bash', cap: 'readonly-bash' },
  'widget-sketcher': { tools: 'Read, Glob, Grep, Write', cap: 'write-only' },
  'widget-reader': { tools: 'Read, Glob, Grep', cap: 'readonly' },
};
const SKILL = 'hedgehog-widget-loop';

const pkg = join(source, 'hedgehog-core-pwa-app');
write(pkg, 'package.json', `${JSON.stringify({ name: '@skyf0xx/hedgehog-core-pwa-app', version: '0.0.1-fixture' }, null, 2)}\n`);
write(
  pkg,
  'hedgehog-core.yaml',
  `name: pwa-app\nflag: --pwa-app\nlanguage: typescript\nengine: "^${engineMajor}.0.0"\ntemplate: CLAUDE.core.md\n` +
    `agents: [${Object.keys(AGENTS).join(', ')}]\nskills: [${SKILL}]\n`,
);
for (const [name, { tools }] of Object.entries(AGENTS)) {
  write(pkg, `agents/${name}.md`, `---\nname: ${name}\ndescription: Builds the ${name} layer. More prose.\ntools: ${tools}\n---\n\nFixture agent.\n`);
}
write(pkg, `skills/${SKILL}/SKILL.md`, `---\nname: ${SKILL}\ndescription: Runs the widget loop. More prose.\n---\n\nFixture skill.\n`);
write(pkg, 'CLAUDE.core.md', '## Widget fixture section\n');

const env = { HEDGEHOG_CORE_SOURCE: source, HEDGEHOG_CORE_NO_CACHE: '1' };

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'hedgehog-agents-md-'));
  projects.push(dir);
  run('git', ['init', '-q'], dir);
  return dir;
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

function checkCoreRows(label, agentsMd) {
  for (const [name, { cap }] of Object.entries(AGENTS)) {
    const row = agentsMd.split('\n').find((l) => l.startsWith(`| \`${name}\` |`));
    check(`${label}: AGENTS.md lists ${name}`, Boolean(row), { expected: 'a row', actual: 'none' });
    if (row) {
      check(`${label}: ${name} row carries the ${cap} grant`, row.includes(CAPABILITY_GRANT[cap].summary), {
        expected: CAPABILITY_GRANT[cap].summary,
        actual: row,
      });
    }
  }
  checkContains(`${label}: AGENTS.md lists the core skill`, agentsMd, `| \`${SKILL}\` | Runs the widget loop. | \`${SKILL}/SKILL.md\` |`);
  checkContains(`${label}: AGENTS.md keeps the engine's planner`, agentsMd, '| `planner` |');
  checkContains(`${label}: AGENTS.md keeps the engine's skills`, agentsMd, '| `hedgehog-daily` |');
}

try {
  for (const [name, { tools, cap }] of Object.entries(AGENTS)) {
    check(`${name}: tools map to ${cap}`, capabilityFromTools(tools) === cap, {
      expected: cap,
      actual: capabilityFromTools(tools),
    });
  }
  check('absent tools fail closed', capabilityFromTools(undefined) === 'readonly', {
    expected: 'readonly',
    actual: capabilityFromTools(undefined),
  });

  // ── 1–2. init --core on Cursor ────────────────────────────────────────
  const a = project();
  const init = hedgehog(a, ['init', '--core', 'pwa-app', '--host=cursor'], env);
  check('init --core on cursor exits 0', init.status === 0, { expected: 'exit 0', actual: `${init.status}\n${init.all}` });
  checkCoreRows('init --core', read(a, 'AGENTS.md'));
  for (const [name, { cap }] of Object.entries(AGENTS)) {
    checkContains(
      `cursor ${name}.md restates the ${cap} grant`,
      read(a, `.cursor/agents/${name}.md`),
      `**Tools for this role:** ${CAPABILITY_GRANT[cap].summary}`,
    );
  }

  // ── 3. coreless init on Gemini, then core install, then update ────────
  const b = project();
  const initB = hedgehog(b, ['init', '--host=gemini'], env);
  check('coreless init on gemini exits 0', initB.status === 0, { expected: 'exit 0', actual: `${initB.status}\n${initB.all}` });
  const coreless = read(b, 'AGENTS.md');
  check('coreless AGENTS.md lists no core agent', !coreless.includes('widget-'), {
    expected: 'no widget-* rows',
    actual: coreless,
  });
  checkContains('coreless AGENTS.md lists the engine planner', coreless, '| `planner` |');

  const install = hedgehog(b, ['core', 'install', 'pwa-app'], env);
  check('core install exits 0', install.status === 0, { expected: 'exit 0', actual: `${install.status}\n${install.all}` });
  checkCoreRows('core install', read(b, 'AGENTS.md'));

  const update = hedgehog(b, ['update'], env);
  check('update exits 0', update.status === 0, { expected: 'exit 0', actual: `${update.status}\n${update.all}` });
  checkCoreRows('update', read(b, 'AGENTS.md'));
} finally {
  for (const dir of projects) rmSync(dir, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
}

finish('agents-md-lists-core');
