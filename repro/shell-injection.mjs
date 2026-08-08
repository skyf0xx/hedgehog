#!/usr/bin/env node
// Reproduction for the command-injection flaw in `src/db/verify.mjs`.
//
// `verify.mjs` built git command lines by string interpolation and ran
// them through `execSync`, i.e. through `/bin/sh`. Its quoting helper was
// `JSON.stringify(path)`, which escapes `"` and `\` but leaves `$` and
// backticks untouched — and the result landed inside double quotes in a
// shell command, where both are still interpreted. Three inputs reach
// those command lines:
//
//   A. a layer's `scope` globs, from `.hedgehog/core.yaml`
//        -> `git diff --name-only HEAD${scopeArgs}`
//        -> `git ls-files --others --exclude-standard${scopeArgs}`
//   B. a layer's `commit` message, from `.hedgehog/core.yaml`
//        -> `git commit -m ${JSON.stringify(commitMessage)}`
//   C. the names of files in the working tree, read back out of
//      `git diff --name-only` / `git ls-files --others`
//        -> `git ls-tree -r --name-only HEAD -- ${quoted}`
//        -> `git add -- ${quoted}`
//
// None of those are attacker-supplied in the classic sense — and that is
// the point. In Hedgehog's model `core.yaml` is written by the
// `hedgehog-core-design` agent and the files are written by build agents,
// so a confused or prompt-injected agent turns a file name into a command
// that the verification gate itself executes.
//
// This script drives the REAL CLI (`bin/cli.mjs verify`), not an
// imitation: each scenario builds a throwaway git repo, runs the real
// db-init / intent / plan / claim / verify sequence against it, and
// checks whether a marker file appeared.
//
// Safety: every scenario runs entirely inside its own `mkdtemp` directory
// and the only thing a payload ever does is create a file inside that
// directory (`touch`/`printf` with a relative path). Nothing is deleted,
// nothing outside the temp directory is written, and the temp directories
// are left behind so the evidence can be inspected.
//
// Expected: FAILS against the unfixed code (markers appear), PASSES once
// the call sites use `execFileSync('git', [...])`.

import { writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, git, hedgehog, makeProject, makeReporter } from './fixture.mjs';

const report = makeReporter();
const presence = (p) => (existsSync(p) ? 'present' : 'absent');

// ── Scenario A: a `scope` glob from core.yaml ───────────────────────────
// `$(touch ../pwn-scope)` substitutes to the empty string, so the
// pathspec git actually received was the innocent `:(glob)src/**` — the
// injection left no trace in the command's behaviour, only in the side
// effect.
function scenarioScopeGlob() {
  console.log('\nScenario A — scope glob from .hedgehog/core.yaml (git diff / git ls-files)');
  const { root, repo, taskId } = makeProject({
    scope: 'src/**$(touch ../pwn-scope)',
    commit: 'feat(demo): layer',
  });
  const marker = join(root, 'pwn-scope');

  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  const res = hedgehog(repo, ['verify', taskId, '--owner', 'repro']);
  console.log(`         (verify exit ${res.status}; temp dir ${root})`);

  report.check('A', 'no marker created by the scope glob', 'absent', presence(marker));
}

// ── Scenario B: the `commit` message from core.yaml ─────────────────────
// Two observable effects: the payload runs, and the injected text is
// consumed by the shell instead of being recorded, so the commit subject
// git stores is not the subject core.yaml declared.
function scenarioCommitMessage() {
  console.log('\nScenario B — commit message from .hedgehog/core.yaml (git commit -m)');
  const declared = 'feat(demo): layer $(touch ../pwn-commit)';
  const { root, repo, taskId } = makeProject({ scope: 'src/**', commit: declared });
  const marker = join(root, 'pwn-commit');

  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  const res = hedgehog(repo, ['verify', taskId, '--owner', 'repro']);
  const subject = git(repo, ['log', '-1', '--format=%s']).trim();
  console.log(`         (verify exit ${res.status}; temp dir ${root})`);
  console.log(`         recorded commit subject: ${JSON.stringify(subject)}`);

  report.check('B', 'no marker created by the commit message', 'absent', presence(marker));
  report.check('B', 'commit subject recorded verbatim', declared, subject);
}

// ── Scenario C: a file name in the working tree ─────────────────────────
// Two payload names, one using `$( )` and one using backticks — neither
// of which `JSON.stringify` escaped. The payload appends one byte per
// execution, so the marker's size counts them: 4 bytes means both call
// sites (`git ls-tree` and `git add`) ran both payloads. Innocent
// siblings `src/evil.ts` / `src/tick.ts` exist so that the pathspecs the
// substitutions collapse to still match real files and the flow runs to
// completion — which also exposes the second half of the bug, namely
// that the payload files themselves silently evade staging.
function scenarioFileName() {
  console.log('\nScenario C — file name in the working tree (git ls-tree / git add)');
  const { root, repo, taskId } = makeProject({ scope: 'src/**', commit: 'feat(demo): layer' });
  const marker = join(repo, 'pwn-count');
  const payloadFiles = ['src/evil$(printf x >>pwn-count).ts', 'src/tick`printf x >>pwn-count`.ts'];

  writeFileSync(join(repo, 'src', 'evil.ts'), 'export const evil = 1;\n');
  writeFileSync(join(repo, 'src', 'tick.ts'), 'export const tick = 1;\n');
  for (const f of payloadFiles) writeFileSync(join(repo, f), 'export const payload = 1;\n');

  const res = hedgehog(repo, ['verify', taskId, '--owner', 'repro']);
  const executions = existsSync(marker) ? statSync(marker).size : 0;
  console.log(`         (verify exit ${res.status}; temp dir ${root})`);
  console.log(`         payload executions recorded: ${executions}`);

  let committed = [];
  try {
    committed = git(repo, ['show', '--name-only', '--format=', 'HEAD'])
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();
  } catch {
    // no commit landed
  }
  console.log(`         files in the verify commit: ${committed.join(', ') || '(none)'}`);

  report.check('C', 'no marker created by the file name', 'absent', presence(marker));
  report.check(
    'C',
    'the payload-named files are actually staged',
    payloadFiles,
    payloadFiles.filter((f) => committed.includes(f)),
  );
}

console.log('Hedgehog `hedgehog verify` command-injection reproduction');
console.log(`CLI under test: ${CLI}`);

scenarioScopeGlob();
scenarioCommitMessage();
scenarioFileName();

report.finish(
  'NOT VULNERABLE — no payload executed, the commit message was recorded verbatim,\nand every in-scope file was staged under its real name.',
  'VULNERABLE — the following checks failed:',
);
