#!/usr/bin/env node
/**
 * Phase gate: "Phase A closes before Phase B opens", enforced in CI.
 *
 * Blocks a PR that introduces a `feat(<module>): hooks` or
 * `feat(<module>): screen-*` commit for a module with no prior
 * `feat(<module>): api` commit already on the branch (or on the base
 * branch it diverged from).
 *
 * Written as CommonJS (`.cjs`) deliberately: root `package.json` sets
 * `"type": "module"`, so a plain `.js` file here would be parsed as ESM
 * and `require`/`module.exports` below would fail with "require is not
 * defined".
 */
const { execSync } = require('node:child_process');

function getCommitSubjects(base) {
  const range = base ? `${base}..HEAD` : 'HEAD';
  const out = execSync(`git log --format=%s ${range}`, { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function main() {
  const base =
    process.env.PHASE_GATE_BASE || process.env.GITHUB_BASE_REF || 'origin/main';

  let subjects;
  try {
    subjects = getCommitSubjects(base);
  } catch {
    // Base ref not resolvable (e.g. shallow clone, no such ref) — fall
    // back to the full local history rather than failing the check for
    // an unrelated git plumbing reason.
    subjects = getCommitSubjects(null);
  }

  const phaseBRe = /^feat\(([a-z0-9-]+)\): (hooks|screen-[\w-]+)/;
  const phaseARe = (mod) => new RegExp(`^feat\\(${mod}\\): api\\b`);

  const violations = [];

  for (const subject of subjects) {
    const match = subject.match(phaseBRe);
    if (!match) continue;

    const mod = match[1];
    const hasPhaseACommit = subjects.some((s) => phaseARe(mod).test(s));

    if (!hasPhaseACommit) {
      violations.push({ subject, mod });
    }
  }

  if (violations.length > 0) {
    console.error(
      'Phase gate failed: Phase B commit(s) with no prior Phase A "api" commit:',
    );
    for (const { subject, mod } of violations) {
      console.error(
        `  - "${subject}" (module: ${mod}) — expected a prior "feat(${mod}): api" commit`,
      );
    }
    process.exit(1);
  }

  console.log(
    'Phase gate passed: every Phase B commit has a prior Phase A "api" commit.',
  );
}

main();
