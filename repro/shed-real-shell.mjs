#!/usr/bin/env node
// Repro: `hedgehog shed` against the real shell template.
//
// The shell's placeholder is `{{PROJECT_SUMMARY — 2–4 sentences…}}`, and
// its bootstrap-only first-message block names `{{PROJECT_SUMMARY}}` in
// prose. The guard has to see the first and ignore the second: a filled
// shell sheds, an unfilled one refuses.
//
// Expected: refuses while the summary is unfilled; once filled, strips
// every bootstrap-only block and prints a byte delta; a second run
// prints `nothing to shed` and exits 0.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  makeProject,
  runCliCapturingBoth,
  cleanup,
  check,
  checkExit,
  checkNonZeroExit,
  checkContains,
  report,
} from './lib/fixture.mjs';

const shell = readFileSync(join(REPO_ROOT, 'src/templates/CLAUDE.md'), 'utf8')
  .replace('{{PROJECT_NAME}}', 'Repro')
  .replace('{{CORE_SECTION}}', '## Core\n\nCore section.')
  .replace('{{HOST_DISPATCH}}', '## Dispatch\n\nDispatch section.');

const project = makeProject();
try {
  const claudeMd = join(project, 'CLAUDE.md');

  writeFileSync(claudeMd, shell);
  const unfilled = runCliCapturingBoth(project, ['shed']);
  checkNonZeroExit('refuses while the summary placeholder is unfilled', unfilled);
  checkContains('names the unfilled placeholder', 'still unfilled in: CLAUDE.md', unfilled.stderr);

  writeFileSync(claudeMd, shell.replace(/\{\{PROJECT_SUMMARY[^}]*\}\}/, 'A repro project.'));
  const first = runCliCapturingBoth(project, ['shed']);
  console.log('--- first stdout\n' + first.stdout);
  console.log('--- first stderr\n' + first.stderr);
  checkExit('sheds once the summary is filled', 0, first);
  checkContains('prints a byte delta', 'CLAUDE.md', first.stdout);
  const shed = readFileSync(claudeMd, 'utf8');
  check('no bootstrap-only block remains', {
    expected: false,
    actual: shed.includes('hedgehog:bootstrap-only'),
  });
  check('the filled summary survives', { expected: true, actual: shed.includes('A repro project.') });

  const second = runCliCapturingBoth(project, ['shed']);
  checkExit('a second run exits 0', 0, second);
  checkContains('a second run has nothing to shed', 'nothing to shed', second.stdout);
} finally {
  cleanup(project);
}

report('shed-real-shell');
