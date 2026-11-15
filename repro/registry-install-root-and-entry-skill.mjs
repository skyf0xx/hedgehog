#!/usr/bin/env node
// Repro: a core's `install_root` and `entry_skill` registry fields
// (src/registry/cores.json) drive `init`'s scratch install and hand-off.
//
// Network-free: the copywriting package is built in a temp directory and
// resolved through HEDGEHOG_CORE_SOURCE, with HEDGEHOG_CORE_NO_CACHE set.
//
// Asserts, for `--copywriting`, `--core copywriting` and
// `--core=copywriting` alike:
//   1. the install lands in a fresh scratch directory and leaves the
//      invoking directory empty;
//   2. the next step names the registry's entry_skill and the invoking
//      directory, and there is no planner/bootstrap hand-off;
// and that `--help` lists every flagged core from the registry.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { check, checkContains, finish, hedgehog, REPO_ROOT } from './papercuts-lib.mjs';

console.log('repro: registry-install-root-and-entry-skill');

const registry = JSON.parse(readFileSync(join(REPO_ROOT, 'src/registry/cores.json'), 'utf8')).cores;
const entry = registry.find((c) => c.install_root === 'scratch');
check('the registry declares a scratch-installed core', Boolean(entry), {
  expected: 'a core with install_root "scratch"',
  actual: 'none',
});

const source = mkdtempSync(join(tmpdir(), 'hedgehog-install-root-src-'));
const cleanupDirs = [source];

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const engineMajor = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version.split('.')[0];
const pkgRoot = join(source, entry.package.split('/').pop());
write(pkgRoot, 'package.json', `${JSON.stringify({ name: entry.package, version: '0.0.1-fixture' }, null, 2)}\n`);
write(
  pkgRoot,
  'hedgehog-core.yaml',
  `name: ${entry.name}\nflag: ${entry.flag}\nlanguage: typescript\nengine: "^${engineMajor}.0.0"\nworkspace: workspace/\ntemplate: CLAUDE.core.md\nagents: [copy-writer]\nskills: [${entry.entry_skill}]\n`,
);
write(pkgRoot, 'agents/copy-writer.md', '---\nname: copy-writer\ndescription: Fixture agent.\ntools: Read, Bash\n---\n\nFixture.\n');
write(pkgRoot, `skills/${entry.entry_skill}/SKILL.md`, `---\nname: ${entry.entry_skill}\ndescription: Fixture skill.\n---\n\nFixture.\n`);
write(pkgRoot, 'CLAUDE.core.md', '## Fixture section\n');
write(
  pkgRoot,
  'workspace/core.yaml',
  'id: copywriting\nlayers:\n  - id: draft\n    scope: ["draft.md"]\n    verify: "true"\n    commit: "docs: draft"\n',
);

const env = { HEDGEHOG_CORE_SOURCE: source, HEDGEHOG_CORE_NO_CACHE: '1' };

for (const form of [[entry.flag], ['--core', entry.name], [`--core=${entry.name}`]]) {
  const label = form.join(' ');
  const origin = mkdtempSync(join(tmpdir(), 'hedgehog-install-root-origin-'));
  cleanupDirs.push(origin);
  const res = hedgehog(origin, ['init', ...form], env);
  check(`${label}: init exits 0`, res.status === 0, { expected: 'exit 0', actual: `${res.status}\n${res.all}` });

  const scratch = res.all.match(/using (\S+)\)/)?.[1];
  if (scratch) cleanupDirs.push(scratch);
  check(`${label}: installs into a scratch directory`, Boolean(scratch) && scratch !== origin, {
    expected: 'a "using <dir>" line naming another directory',
    actual: res.all.slice(0, 300),
  });
  check(`${label}: the scratch directory holds the install`, Boolean(scratch) && existsSync(join(scratch, '.hedgehog')), {
    expected: '.hedgehog/ in the scratch directory',
    actual: scratch ?? '(none)',
  });
  check(`${label}: the invoking directory is untouched`, readdirSync(origin).length === 0, {
    expected: 'empty',
    actual: readdirSync(origin).join(', '),
  });
  checkContains(`${label}: next step names the entry skill`, res.all, `${entry.entry_skill}/SKILL.md`);
  checkContains(`${label}: and says where the finished piece lands`, res.all, origin);
  check(`${label}: no planner hand-off`, !/Read \S*planner\.md/.test(res.all), {
    expected: 'no planner.md pointer',
    actual: res.all.slice(-600),
  });
}

const help = hedgehog(REPO_ROOT, ['--help']);
for (const core of registry.filter((c) => c.flag)) {
  checkContains(`--help lists ${core.flag}`, help.all, `init ${core.flag}`);
}

for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
finish('registry-install-root-and-entry-skill');
