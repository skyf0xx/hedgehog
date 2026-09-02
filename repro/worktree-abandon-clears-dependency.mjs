// `hedgehog abandon` resets an intent's own status and tasks to planned
// (worktree-abandon.mjs already covers that), but an `intent_dependencies`
// row naming the abandoned intent — on either side — is a separate fact:
// eligibleIntents (worktree.mjs) reads that table directly to decide
// whether an intent gets its own worktree, so a stale row left behind by
// abandonment can make an unrelated intent look worktree-eligible against
// a dependency that no longer really applies, or make the abandoned intent
// itself look eligible again against a dependency its own committed JSON
// no longer declares.
//
// Repro shape: `beta` depends_on `alpha` (already complete), so `beta`
// gets its own worktree the moment it's added — exactly the trigger
// documented in `hedgehog plan`'s own help text. `beta` is then abandoned,
// its intent file is edited to drop the dependency, and re-committed. A
// `hedgehog db rebuild` from there must show no `intent_dependencies` row
// for `beta` at all, and must not mark `beta` (fresh, zero commits since
// the edit) complete.

import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  makeProject,
  cli,
  openGraph,
  commitTaskSubject,
  cleanup,
  check,
} from './_lib.mjs';
import { report } from './_lib.mjs';

const CORE = `
id: dep-cleanup-fixture
layers:
  - id: view
    scope: ["src/{module}/**"]
    verify: "true"
    commit: "feat({module}): view"
`;

const dir = makeProject(CORE, { git: true });
let worktreePath;
try {
  writeFileSync(
    join(dir, '.gitignore'),
    '.hedgehog/hedgehog.db\n.hedgehog/hedgehog.db-*\n.hedgehog/commit.lock\n',
  );
  execFileSync('git', ['add', '.gitignore'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: gitignore build graph'], { cwd: dir });

  check(
    'add alpha exits 0',
    0,
    cli(dir, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']).status,
  );
  check('first plan exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  commitTaskSubject(dir, 'ALPHA-VIEW');
  check('rebuild exits 0', 0, cli(dir, ['db', 'rebuild']).status);

  check(
    'add beta (depends on complete alpha) exits 0',
    0,
    cli(dir, [
      'intent',
      'add',
      '--id',
      'beta',
      '--goal',
      'g',
      '--outcome',
      'o',
      '--depends-on',
      'alpha',
    ]).status,
  );
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: add beta intent'], { cwd: dir });

  check('plan (creates the beta worktree) exits 0', 0, cli(dir, ['plan', '--no-open']).status);

  const repoName = dir.split('/').filter(Boolean).pop();
  worktreePath = join(dir, '..', `${repoName}.hedgehog-beta`);
  check('the worktree exists before abandoning', true, existsSync(worktreePath));

  const dbBefore = openGraph(dir);
  let depRowBefore;
  try {
    depRowBefore = dbBefore
      .prepare(
        "SELECT COUNT(*) AS n FROM intent_dependencies WHERE intent_id = 'beta' OR depends_on_intent_id = 'beta'",
      )
      .get().n;
  } finally {
    dbBefore.close();
  }
  check('beta declares its dependency on alpha before abandoning', 1, depRowBefore);

  const abandoned = cli(dir, ['abandon', 'beta', '--reason', 'requirements changed']);
  check('abandon exits 0', 0, abandoned.status);
  check('the worktree was removed', false, existsSync(worktreePath));

  // The core assertion for this repro: abandon must clear the dependency
  // edge, not just reset beta's own status.
  const dbAfter = openGraph(dir);
  let depRowAfter, betaStatus;
  try {
    depRowAfter = dbAfter
      .prepare(
        "SELECT COUNT(*) AS n FROM intent_dependencies WHERE intent_id = 'beta' OR depends_on_intent_id = 'beta'",
      )
      .get().n;
    betaStatus = dbAfter.prepare("SELECT status FROM intents WHERE id = 'beta'").get().status;
  } finally {
    dbAfter.close();
  }
  check('no intent_dependencies row survives naming beta, either side', 0, depRowAfter);
  check('beta intent is reset to planned on trunk', 'planned', betaStatus);

  // Edit the committed intent file to drop the dependency — the documented
  // recovery path (this repo's own `hedgehog abandon` output says so): no
  // `intent add` re-run, just edit the file and replan.
  const intentPath = join(dir, '.hedgehog/intents/beta.json');
  const record = JSON.parse(readFileSync(intentPath, 'utf8'));
  check('beta.json still declares the old dependency before editing', ['alpha'], record.depends_on);
  record.depends_on = [];
  writeFileSync(intentPath, JSON.stringify(record, null, 2));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: drop beta dependency on alpha'], { cwd: dir });

  // A rebuild from here must not mark beta or its tasks complete — no
  // commit exists for BETA-VIEW, and its committed JSON no longer declares
  // any dependency for a stale intent_dependencies row to leak from.
  execFileSync('git', ['add', '-A'], { cwd: dir });
  const rebuilt = cli(dir, ['db', 'rebuild']);
  check('db rebuild exits 0', 0, rebuilt.status);

  const dbFinal = openGraph(dir);
  let betaFinalStatus, betaTaskStatuses, depRowFinal;
  try {
    betaFinalStatus = dbFinal.prepare("SELECT status FROM intents WHERE id = 'beta'").get()
      .status;
    betaTaskStatuses = dbFinal
      .prepare("SELECT status FROM tasks WHERE intent_id = 'beta'")
      .all()
      .map((r) => r.status);
    depRowFinal = dbFinal
      .prepare(
        "SELECT COUNT(*) AS n FROM intent_dependencies WHERE intent_id = 'beta' OR depends_on_intent_id = 'beta'",
      )
      .get().n;
  } finally {
    dbFinal.close();
  }
  check('beta intent is not complete after rebuild with zero commits', true, betaFinalStatus !== 'complete');
  check(
    'beta has no task marked complete with zero commits behind it',
    true,
    betaTaskStatuses.every((s) => s !== 'complete'),
  );
  check('rebuild replays no dependency row for beta (JSON no longer declares one)', 0, depRowFinal);
} finally {
  if (worktreePath) cleanup(worktreePath);
  cleanup(dir);
}

report(
  'hedgehog abandon clears intent_dependencies edges, and a rebuild after dropping the ' +
    'dependency does not mark the intent complete with zero commits',
);
