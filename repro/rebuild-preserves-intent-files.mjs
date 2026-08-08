// Reproduction: the destructive rewrite, isolated from the ordering bug.
//
// Same four intents, renamed so alphabetical order already AGREES with
// dependency order (a-board, b-list, c-card, d-automation). The rebuild
// therefore never hits a FOREIGN KEY error — and still destroys the
// permanent record, because the replay path writes each intent file back
// out through `normalizeIntent`, which reads the INPUT fields
// (rules/constraints/acceptance) that an already-written file no longer
// has, and writes the OUTPUT field (requirements) as `[]`.
//
// Asserts:
//   1. the rebuild completes
//   2. every `.hedgehog/intents/*.json` file is BYTE-IDENTICAL afterwards
//   3. git reports no modification to the committed intent files
//   4. the DB holds every requirement the files declare
//
// Runs entirely inside a temp dir created by the harness.

import { execFileSync } from 'node:child_process';
import { rebuildDb } from '../src/db/rebuild.mjs';
import { openDb, dbInit, DB_PATH } from '../src/db/init.mjs';
import {
  IN_ORDER_INTENTS,
  makeProject,
  snapshotIntents,
  diffSnapshots,
  reportSnapshot,
  check,
  assert,
  assertEqual,
  finish,
} from './harness.mjs';

console.log('repro: rebuild must not rewrite the committed intent files\n');

const root = await makeProject(IN_ORDER_INTENTS);
console.log(`  temp project: ${root}`);
console.log('  alphabetical order already matches dependency order\n');

const before = await snapshotIntents(root);
reportSnapshot('before rebuild:', before);
console.log('');

await dbInit(DB_PATH);
const db = openDb();

let rebuildError = null;
let result = null;
try {
  result = await rebuildDb(db, { corePath: '.hedgehog/core.yaml' });
} catch (err) {
  rebuildError = err;
}

const after = await snapshotIntents(root);
reportSnapshot('after rebuild:', after);
console.log('');

const gitStatus = execFileSync('git', ['status', '--porcelain', '.hedgehog/intents'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
console.log(`  git status .hedgehog/intents: ${gitStatus === '' ? '(clean)' : `\n${gitStatus}`}`);
console.log('');

check('1. rebuild completes without throwing', () => {
  assert(rebuildError === null, `rebuild threw: ${rebuildError && rebuildError.message}`);
  assertEqual(result.intentsReplayed, IN_ORDER_INTENTS.length, 'intents replayed');
});

check('2. every intent JSON file is byte-identical after the rebuild', () => {
  const problems = diffSnapshots(before, after);
  assert(problems.length === 0, `intent files changed on disk:\n  ${problems.join('\n  ')}`);
});

check('3. git sees no change to the committed intent files', () => {
  assertEqual(gitStatus, '', 'git status of .hedgehog/intents should be clean');
});

check('4. the DB holds every requirement the intent files declare', () => {
  for (const intent of IN_ORDER_INTENTS) {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM requirements WHERE intent_id = ?')
      .get(intent.id);
    assertEqual(
      row ? row.n : 0,
      intent.requirements.length,
      `requirement rows for intent "${intent.id}"`,
    );
  }
});

db.close();
finish('rebuild-preserves-intent-files');
