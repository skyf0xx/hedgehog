#!/usr/bin/env node
// Repro: `hedgehog core install <name>` lands a core into a project whose
// `init` named none, and `core record-adopted` does the same for `adopted`.
//
// Network-free: the core packages are built in a temp directory and
// resolved through HEDGEHOG_CORE_SOURCE (src/registry/fetch.mjs), with
// HEDGEHOG_CORE_NO_CACHE set so nothing lands in ~/.hedgehog/cores/.
//
// Asserts:
//   1. after a coreless `init`, `core install landing-page` lands the
//      core's agents, skills and workspace, fills {{CORE_SECTION}} in
//      CLAUDE.md, appends the core's .gitignore lines to the engine's,
//      and records the core in .hedgehog/core.json;
//   2. installing a different core over a recorded one is refused and
//      changes nothing;
//   3. installing the recorded core again reports it as installed and
//      changes nothing; --force reinstalls it;
//   4. `core record-adopted` on a two-host project with a hand-written
//      CLAUDE.md appends the section there, fills the other host's shell,
//      lands agents for both hosts, keeps .hedgehog/CLAUDE.core.md,
//      prints no commit step, and stays idempotent on a re-run;
//   5. a core with no workspace leaves an absent instructions file absent;
//   6. existing workspace files, copywriting, a fetch failure and an
//      engine-range failure are each refused with the tree untouched.
//
// Run: node repro/core-install-local-source.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { check, checkContains, finish, hedgehog, run, REPO_ROOT } from './papercuts-lib.mjs';

console.log('repro: core-install-local-source');

const source = mkdtempSync(join(tmpdir(), 'hedgehog-core-install-src-'));
const projects = [];

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function agent(name) {
  return `---\nname: ${name}\ndescription: Fixture agent ${name}.\ntools: Read, Bash\n---\n\nFixture agent.\n`;
}

function skill(name) {
  return `---\nname: ${name}\ndescription: Fixture skill ${name}.\n---\n\nFixture skill.\n`;
}

function fixturePackage(dirName, pkgName, manifest, files) {
  const root = join(source, dirName);
  write(root, 'package.json', `${JSON.stringify({ name: pkgName, version: '0.0.1-fixture' }, null, 2)}\n`);
  write(root, 'hedgehog-core.yaml', manifest);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
}

const engineMajor = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version.split('.')[0];
const engine = `"^${engineMajor}.0.0"`;

fixturePackage(
  'hedgehog-core-landing-page',
  '@skyf0xx/hedgehog-core-landing-page',
  `name: landing-page\nflag: --landing-page\nlanguage: typescript\nengine: ${engine}\nworkspace: workspace/\ntemplate: CLAUDE.core.md\nagents: [landing-builder]\nskills: [hedgehog-landing-loop]\n`,
  {
    'agents/landing-builder.md': agent('landing-builder'),
    'skills/hedgehog-landing-loop/SKILL.md': skill('hedgehog-landing-loop'),
    'CLAUDE.core.md': '## Landing fixture section\n\nLANDING-SECTION-BODY\n',
    'workspace/core.yaml':
      'id: landing-page\nlayers:\n  - id: brief\n    scope: ["brief.md"]\n    verify: "true"\n    commit: "chore: brief"\n',
    'workspace/package.json': '{ "name": "fixture-workspace", "private": true }\n',
    'workspace/gitignore.template': 'dist\n.hedgehog/hedgehog.db\n',
  },
);

fixturePackage(
  'hedgehog-core-adopted',
  '@skyf0xx/hedgehog-core-adopted',
  `name: adopted\nflag: null\nlanguage: typescript\nengine: ${engine}\ntemplate: CLAUDE.core.md\nagents: [layer-eng]\nskills: [hedgehog-adopt]\n`,
  {
    'agents/layer-eng.md': agent('layer-eng'),
    'skills/hedgehog-adopt/SKILL.md': skill('hedgehog-adopt'),
    'CLAUDE.core.md': '## Adopted fixture section\n\nADOPTED-SECTION-BODY\n',
  },
);

// A core written against an engine line far ahead of this CLI.
fixturePackage(
  'hedgehog-core-deepseek-harness',
  '@skyf0xx/hedgehog-core-deepseek-harness',
  `name: deepseek-harness\nflag: --deepseek-harness\nlanguage: typescript\nengine: "^${Number(engineMajor) + 90}.0.0"\ntemplate: CLAUDE.core.md\nagents: [harness-eng]\nskills: [hedgehog-dsh-loop]\n`,
  {
    'agents/harness-eng.md': agent('harness-eng'),
    'skills/hedgehog-dsh-loop/SKILL.md': skill('hedgehog-dsh-loop'),
    'CLAUDE.core.md': '## DSH fixture section\n',
  },
);

const env = { HEDGEHOG_CORE_SOURCE: source, HEDGEHOG_CORE_NO_CACHE: '1' };

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'hedgehog-core-install-'));
  projects.push(dir);
  run('git', ['init', '-q'], dir);
  return dir;
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

// Every file under `dir` but .git, with its content, for a before/after
// comparison.
function snapshot(dir, rel = '') {
  const out = {};
  for (const name of readdirSync(join(dir, rel))) {
    if (rel === '' && name === '.git') continue;
    const child = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, child)).isDirectory()) Object.assign(out, snapshot(dir, child));
    else out[child] = readFileSync(join(dir, child), 'utf8');
  }
  return out;
}

function checkUntouched(label, dir, before) {
  const after = snapshot(dir);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => before[k] !== after[k],
  );
  check(`${label}: tree untouched`, changed.length === 0, {
    expected: 'no file added, removed or changed',
    actual: changed.join(', '),
  });
}
const count = (haystack, needle) => haystack.split(needle).length - 1;

try {
  // ── 1. install after a coreless init ──────────────────────────────────
  const a = project();
  const init = hedgehog(a, ['init'], env);
  check('coreless init succeeds', init.status === 0, { expected: 'exit 0', actual: `${init.status}\n${init.all}` });
  checkContains('coreless init leaves the placeholder', read(a, 'CLAUDE.md'), '{{CORE_SECTION}}');

  const install = hedgehog(a, ['core', 'install', 'landing-page'], env);
  check('core install exits 0', install.status === 0, { expected: 'exit 0', actual: `${install.status}\n${install.all}` });
  for (const rel of [
    '.claude/agents/landing-builder.md',
    '.claude/skills/hedgehog-landing-loop/SKILL.md',
    'core.yaml',
    'package.json',
  ]) {
    check(`lands ${rel}`, existsSync(join(a, rel)), { expected: 'file exists', actual: 'missing' });
  }
  const claudeMd = read(a, 'CLAUDE.md');
  checkContains('CLAUDE.md carries the core section', claudeMd, 'LANDING-SECTION-BODY');
  check('CLAUDE.md placeholder is filled', !claudeMd.includes('{{CORE_SECTION}}'), {
    expected: 'no {{CORE_SECTION}}',
    actual: 'placeholder still present',
  });
  const gitignore = read(a, '.gitignore');
  checkContains('.gitignore gains the core line', gitignore, 'dist');
  checkContains('.gitignore keeps the engine lines', gitignore, '.hedgehog/commit.lock');
  check('.gitignore has no duplicate line', count(gitignore, '.hedgehog/hedgehog.db\n') === 1, {
    expected: 'one .hedgehog/hedgehog.db line',
    actual: gitignore,
  });
  check('core install does not suggest git add -A', !install.all.includes('git add -A'), {
    expected: 'no git add -A',
    actual: install.all,
  });
  checkContains('core install names the commit', install.all, 'Commit the files listed above');
  const record = JSON.parse(read(a, '.hedgehog/core.json'));
  check('core is recorded', record.core === 'landing-page', { expected: 'landing-page', actual: record.core });

  // ── 2. a different core is refused ────────────────────────────────────
  const other = hedgehog(a, ['core', 'install', 'adopted'], env);
  check('different core refused', other.status === 1, { expected: 'exit 1', actual: `${other.status}\n${other.all}` });
  checkContains('refusal names the recorded core', other.all, 'A different core is already installed');
  check('refusal changes nothing', JSON.parse(read(a, '.hedgehog/core.json')).core === 'landing-page', {
    expected: 'record still landing-page',
    actual: read(a, '.hedgehog/core.json'),
  });

  // ── 3. same core again: already installed, then --force ──────────────
  const beforeAgain = snapshot(a);
  const again = hedgehog(a, ['core', 'install', 'landing-page'], env);
  check('re-install reports installed', again.status === 0, { expected: 'exit 0', actual: `${again.status}\n${again.all}` });
  checkContains('re-install says already installed', again.all, 'Already installed');
  checkContains('re-install points at update', again.all, 'hedgehog update');
  checkUntouched('re-install', a, beforeAgain);
  const forced = hedgehog(a, ['core', 'install', 'landing-page', '--force'], env);
  check('re-install with --force succeeds', forced.status === 0, { expected: 'exit 0', actual: `${forced.status}\n${forced.all}` });
  check('section not duplicated', count(read(a, 'CLAUDE.md'), 'LANDING-SECTION-BODY') === 1, {
    expected: 'one section',
    actual: String(count(read(a, 'CLAUDE.md'), 'LANDING-SECTION-BODY')),
  });

  // ── 4. record-adopted: two hosts, hand-written CLAUDE.md ──────────────
  const b = project();
  writeFileSync(join(b, 'CLAUDE.md'), '# Existing project\n\nHAND-WRITTEN-BODY\n');
  const initB = hedgehog(b, ['init', '--host=claude,cursor'], env);
  check('two-host coreless init succeeds', initB.status === 0, { expected: 'exit 0', actual: `${initB.status}\n${initB.all}` });

  const adopted = hedgehog(b, ['core', 'record-adopted'], env);
  check('record-adopted exits 0', adopted.status === 0, { expected: 'exit 0', actual: `${adopted.status}\n${adopted.all}` });
  const bClaude = read(b, 'CLAUDE.md');
  checkContains('hand-written CLAUDE.md is kept', bClaude, 'HAND-WRITTEN-BODY');
  checkContains('hand-written CLAUDE.md gains the section', bClaude, 'ADOPTED-SECTION-BODY');
  const hedgehogMd = read(b, 'HEDGEHOG.md');
  checkContains('cursor instructions file gains the section', hedgehogMd, 'ADOPTED-SECTION-BODY');
  check('cursor placeholder is filled', !hedgehogMd.includes('{{CORE_SECTION}}'), {
    expected: 'no {{CORE_SECTION}}',
    actual: 'placeholder still present',
  });
  for (const rel of ['.claude/agents/layer-eng.md', '.cursor/agents/layer-eng.md', '.hedgehog/CLAUDE.core.md']) {
    check(`lands ${rel}`, existsSync(join(b, rel)), { expected: 'file exists', actual: 'missing' });
  }
  check('adopted is recorded', JSON.parse(read(b, '.hedgehog/core.json')).core === 'adopted', {
    expected: 'adopted',
    actual: read(b, '.hedgehog/core.json'),
  });

  check('record-adopted prints no commit step', !/git add|Commit the files/.test(adopted.all), {
    expected: 'no commit step',
    actual: adopted.all,
  });

  const rerun = hedgehog(b, ['core', 'record-adopted'], env);
  check('record-adopted re-run exits 0', rerun.status === 0, { expected: 'exit 0', actual: `${rerun.status}\n${rerun.all}` });
  check('re-run keeps one section', count(read(b, 'CLAUDE.md'), 'ADOPTED-SECTION-BODY') === 1, {
    expected: 'one section',
    actual: String(count(read(b, 'CLAUDE.md'), 'ADOPTED-SECTION-BODY')),
  });

  // ── 5. no workspace: an absent instructions file stays absent ─────────
  const c = project();
  hedgehog(c, ['init', '--host=claude,cursor'], env);
  rmSync(join(c, 'CLAUDE.md'));
  const adoptedC = hedgehog(c, ['core', 'record-adopted'], env);
  check('record-adopted without CLAUDE.md exits 0', adoptedC.status === 0, {
    expected: 'exit 0',
    actual: `${adoptedC.status}\n${adoptedC.all}`,
  });
  check('absent CLAUDE.md stays absent', !existsSync(join(c, 'CLAUDE.md')), {
    expected: 'no CLAUDE.md',
    actual: 'CLAUDE.md created',
  });
  checkContains('present HEDGEHOG.md still gains the section', read(c, 'HEDGEHOG.md'), 'ADOPTED-SECTION-BODY');

  // ── 6. refusals leave the tree untouched ──────────────────────────────
  const d = project();
  hedgehog(d, ['init'], env);
  writeFileSync(join(d, 'package.json'), '{ "name": "users-own" }\n');
  let before = snapshot(d);
  const conflict = hedgehog(d, ['core', 'install', 'landing-page'], env);
  check('existing workspace file refused', conflict.status === 1, { expected: 'exit 1', actual: `${conflict.status}\n${conflict.all}` });
  checkContains('conflict lists package.json', conflict.all, 'package.json');
  checkUntouched('workspace conflict', d, before);

  before = snapshot(d);
  const copy = hedgehog(d, ['core', 'install', 'copywriting'], env);
  check('copywriting refused', copy.status === 1, { expected: 'exit 1', actual: `${copy.status}\n${copy.all}` });
  checkContains('copywriting refusal points at init --copywriting', copy.all, 'hedgehog init --copywriting');
  checkUntouched('copywriting', d, before);

  before = snapshot(d);
  const missing = hedgehog(d, ['core', 'install', 'pwa-app'], env);
  check('fetch failure refused', missing.status === 1, { expected: 'exit 1', actual: `${missing.status}\n${missing.all}` });
  checkContains('fetch failure says unavailable', missing.all, 'Core unavailable');
  checkUntouched('fetch failure', d, before);

  before = snapshot(d);
  const ahead = hedgehog(d, ['core', 'install', 'deepseek-harness'], env);
  check('engine-range failure refused', ahead.status === 1, { expected: 'exit 1', actual: `${ahead.status}\n${ahead.all}` });
  checkContains('engine-range failure names the engine line', ahead.all, 'This core needs Hedgehog');
  checkUntouched('engine-range failure', d, before);
} finally {
  for (const dir of projects) rmSync(dir, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
}

finish('core-install-local-source');
