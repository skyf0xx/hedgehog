// Reproduction: satisfied.mjs's `possiblySatisfiedTasks` flags a
// `planned` task whose scope glob is already covered by tracked, clean
// files, and stops flagging it the moment a file in that scope goes
// dirty.
//
// Runs entirely inside a temp git project created by `_lib.mjs`.

import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { possiblySatisfiedTasks } from '../src/db/satisfied.mjs';
import { ONCE_CORE, makeProject, addIntent, cli, openGraph, cleanup, check, report } from './_lib.mjs';

console.log('repro: possibly-satisfied task detection\n');

const dir = makeProject(ONCE_CORE, { git: true });
process.chdir(dir);
addIntent(dir, 'billing');
const planned = cli(dir, ['plan']);
if (planned.status !== 0) throw new Error(`plan failed: ${planned.stderr}`);

const git = (...args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });

const db = openGraph(dir);
const schemaTask = db
  .prepare("SELECT id, status FROM tasks WHERE layer = 'schema' AND module = 'billing'")
  .get();
check('schema task starts planned', 'planned', schemaTask.status);

check('nothing flagged before any file exists in scope', [], possiblySatisfiedTasks(db));

mkdirSync(join(dir, 'libs/billing/schema'), { recursive: true });
writeFileSync(join(dir, 'libs/billing/schema/model.ts'), 'export const x = 1;\n');
git('add', '-A');
git('commit', '-q', '-m', 'feat(billing): hand-authored schema, wrong subject');

const flaggedAfterCommit = possiblySatisfiedTasks(db);
check('flagged after a tracked, clean file lands in scope', [schemaTask.id], flaggedAfterCommit.map((t) => t.id));

appendFileSync(join(dir, 'libs/billing/schema/model.ts'), 'export const y = 2;\n');
const flaggedWhileDirty = possiblySatisfiedTasks(db);
check('not flagged while the scope has an uncommitted change', [], flaggedWhileDirty.map((t) => t.id));

git('commit', '-aq', '-m', 'chore: settle');
const flaggedAfterSettling = possiblySatisfiedTasks(db);
check('flagged again once clean', [schemaTask.id], flaggedAfterSettling.map((t) => t.id));

db.close();
cleanup(dir);
report('possibly-satisfied task detection');
