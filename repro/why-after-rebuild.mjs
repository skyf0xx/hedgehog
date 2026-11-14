// `hedgehog why` names the task that wrote a file after the artifacts
// table is gone (clone, merge, `db rebuild`), by matching git history
// against task commit messages.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, addIntent, cli, openGraph, cleanup, check, checkContains, report, LINEAR_CORE, rebuildFromScratch } from './_lib.mjs';

const dir = makeProject(LINEAR_CORE, { git: true });
try {
  addIntent(dir, 'alpha');
  check('plan exits 0', 0, cli(dir, ['plan']).status);
  const db = openGraph(dir);
  const task = db.prepare("SELECT id, commit_message FROM tasks WHERE layer = 'scaffold'").get();
  db.close();

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/a.txt'), 'a\n');
  writeFileSync(join(dir, 'other.txt'), 'o\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('add', 'src/a.txt');
  git('commit', '-q', '-m', task.commit_message);
  git('add', 'other.txt');
  git('commit', '-q', '-m', 'docs: unrelated');

  check('rebuild exits 0', 0, rebuildFromScratch(dir).status);

  const named = cli(dir, ['why', 'src/a.txt']);
  checkContains('why names the task after rebuild', named.stdout, task.id);
  checkContains('why marks the answer as derived from git', named.stdout, 'derived from git history');

  const none = cli(dir, ['why', 'other.txt']);
  checkContains('untraceable path says no commit matches', none.stdout, 'no commit touching this path matches');
} finally {
  cleanup(dir);
}

report('why — names the task from git history after a rebuild');
