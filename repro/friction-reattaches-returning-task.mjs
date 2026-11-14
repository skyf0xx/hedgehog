// A rebuild only reads friction records. When a record's task is missing
// from the rebuilt graph (an older checkout, an intent mid-rename), the row
// is kept with no task, but the record keeps its task and the working tree
// stays clean. When the task returns, the next rebuild re-attaches the row.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, addIntent, cli, openGraph, cleanup, check, report, ONCE_CORE } from './_lib.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

const taskOfRow = (dir) => {
  const db = openGraph(dir);
  try {
    return db.prepare("SELECT task_id FROM friction WHERE note = 'schema snag'").get()?.task_id;
  } finally {
    db.close();
  }
};

const dir = makeProject(ONCE_CORE, { git: true });
try {
  writeFileSync(join(dir, '.gitignore'), '.hedgehog/hedgehog.db\n.hedgehog/hedgehog.db-*\n.hedgehog/commit.lock\n.hedgehog/graph-server.json\n');
  addIntent(dir, 'task');
  check('plan exits 0', 0, cli(dir, ['plan', '--no-open']).status);
  check('friction add exits 0', 0, cli(dir, ['friction', 'add', 'schema snag', '--task', 'TASK-SCHEMA']).status);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'chore: intent and friction']);

  const frictionDir = join(dir, '.hedgehog/friction');
  const recordPath = join(frictionDir, readdirSync(frictionDir).find((n) => n.endsWith('.json')));
  const recordBefore = readFileSync(recordPath, 'utf8');

  const intentPath = join(dir, '.hedgehog/intents/task.json');
  const parked = join(dir, 'task.json.parked');
  renameSync(intentPath, parked);
  check('db rebuild without the intent exits 0', 0, cli(dir, ['db', 'rebuild']).status);
  check('the row is kept with no task', null, taskOfRow(dir));
  check('the record is unchanged', recordBefore, readFileSync(recordPath, 'utf8'));
  check('the rebuild left the friction records clean', '', git(dir, ['status', '--porcelain', '--', '.hedgehog/friction']).trim());
  renameSync(parked, intentPath);

  check('db rebuild with the intent restored exits 0', 0, cli(dir, ['db', 'rebuild']).status);
  check('the row re-attaches to the returning task', 'TASK-SCHEMA', taskOfRow(dir));
} finally {
  cleanup(dir);
}

report('a rebuild never writes friction records, and a returning task re-attaches its friction');
