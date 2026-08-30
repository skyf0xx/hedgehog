// `hedgehog abandon <intent-id> --reason "<why>"` — writes a committed
// abandonment record (`.hedgehog/abandoned/<intent-id>.json`,
// worktree.mjs), resets the intent's tasks to `planned` on trunk, and
// removes the worktree and branch. Must survive `hedgehog db rebuild` —
// the intent must not silently reappear as in-progress after a rebuild,
// the same durability rule the debt/decisions prerequisite fixed for
// notes (rebuild.mjs's file header, worktree.mjs#replayAbandonments).

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
  report,
} from './_lib.mjs';

const CORE = `
id: abandon-fixture
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

  check('add alpha exits 0', 0, cli(dir, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']).status);
  check('first plan exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  commitTaskSubject(dir, 'ALPHA-VIEW');
  check('rebuild exits 0', 0, cli(dir, ['db', 'rebuild']).status);

  check(
    'add beta (depends on complete alpha) exits 0',
    0,
    cli(dir, ['intent', 'add', '--id', 'beta', '--goal', 'g', '--outcome', 'o', '--depends-on', 'alpha']).status,
  );
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: add beta intent'], { cwd: dir });

  check('plan (creates the beta worktree) exits 0', 0, cli(dir, ['plan', '--no-open']).status);

  const repoName = dir.split('/').filter(Boolean).pop();
  worktreePath = join(dir, '..', `${repoName}.hedgehog-beta`);
  check('the worktree exists before abandoning', true, existsSync(worktreePath));

  // Abandoning without --reason refuses.
  const noReason = cli(dir, ['abandon', 'beta']);
  check('abandon without --reason refuses', 1, noReason.status);

  const abandoned = cli(dir, ['abandon', 'beta', '--reason', 'requirements changed, no longer needed']);
  check('abandon exits 0', 0, abandoned.status);

  const recordPath = join(dir, '.hedgehog/abandoned/beta.json');
  check('a committed abandonment record was written', true, existsSync(recordPath));
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  check('the record names the right intent', 'beta', record.intent);
  check('the record carries the reason', 'requirements changed, no longer needed', record.reason);

  check('the worktree was removed', false, existsSync(worktreePath));
  const branches = execFileSync('git', ['branch', '--list', 'hedgehog/*'], { cwd: dir, encoding: 'utf8' });
  check('the branch was removed', '', branches.trim());

  const db1 = openGraph(dir);
  let betaStatus;
  try {
    betaStatus = db1.prepare("SELECT status FROM intents WHERE id = 'beta'").get().status;
  } finally {
    db1.close();
  }
  check('beta intent is reset to planned on trunk', 'planned', betaStatus);

  // Commit the abandonment record — the loop's own convention (every
  // committed-record write in this engine says so), and the fact this
  // repro is actually testing: an uncommitted abandonment record would
  // still be picked up here (files on disk, not git history, are what
  // loadAbandoned reads), so commit it to prove the *committed* form
  // survives too, matching how a real project would actually operate.
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: record beta abandonment'], { cwd: dir });

  // The critical property: delete the DB file outright (not just rows —
  // the fresh-clone/merged-worktree scenario this prerequisite exists
  // for) and rebuild. beta must not silently reappear as in-progress.
  for (const suffix of ['', '-wal', '-shm']) {
    execFileSync('rm', ['-f', join(dir, `.hedgehog/hedgehog.db${suffix}`)]);
  }
  const rebuilt = cli(dir, ['db', 'rebuild']);
  check('db rebuild from a deleted DB exits 0', 0, rebuilt.status);
  check('rebuild output names the abandonment', true, rebuilt.stdout.includes('beta'));

  const db2 = openGraph(dir);
  let betaAfterRebuild, betaTasksAfterRebuild;
  try {
    betaAfterRebuild = db2.prepare("SELECT status FROM intents WHERE id = 'beta'").get().status;
    betaTasksAfterRebuild = db2
      .prepare("SELECT status FROM tasks WHERE intent_id = 'beta'")
      .all()
      .map((r) => r.status);
  } finally {
    db2.close();
  }
  check('beta intent is still planned after a rebuild from a deleted DB', 'planned', betaAfterRebuild);
  check(
    'beta has no task stuck in-progress after the rebuild',
    true,
    betaTasksAfterRebuild.every((s) => s === 'planned'),
  );

  // A second abandon on the same intent refuses — one abandonment per
  // intent, the same one-shot contract reconcile.mjs's confirmation files
  // use.
  const secondAbandon = cli(dir, ['abandon', 'beta', '--reason', 'again']);
  check('a second abandon of the same intent refuses', 1, secondAbandon.status);
} finally {
  if (worktreePath) cleanup(worktreePath);
  cleanup(dir);
}

report('hedgehog abandon resets an intent to planned on trunk and survives a rebuild from a deleted DB');
