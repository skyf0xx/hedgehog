// Reproduction: `hedgehog db rebuild` against intents whose alphabetical
// filename order contradicts their `depends_on` order.
//
// Fixtures: automation -> card -> list -> board (dependency order is the
// reverse-ish of alphabetical). `card` carries 22 requirements and `list`
// 10 — the two counts lost on the real project.
//
// Asserts:
//   1. the rebuild completes
//   2. every `.hedgehog/intents/*.json` file is BYTE-IDENTICAL afterwards
//   3. the DB ends up holding every requirement the files declare
//
// Runs entirely inside a temp dir created by the harness.

import { rebuildDb } from '../src/db/rebuild.mjs';
import { openDb, dbInit, DB_PATH } from '../src/db/init.mjs';
import {
  OUT_OF_ORDER_INTENTS,
  makeProject,
  snapshotIntents,
  diffSnapshots,
  reportSnapshot,
  check,
  assert,
  assertEqual,
  finish,
} from './harness.mjs';

console.log('repro: rebuild with alphabetical order contradicting depends_on order\n');

const root = await makeProject(OUT_OF_ORDER_INTENTS, {
  commitSubjects: ['feat(board): schema'],
});
console.log(`  temp project: ${root}`);
console.log('  replay order (alphabetical): automation, board, card, list');
console.log('  dependency order:            board, list, card, automation\n');

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

check('1. rebuild completes without throwing', () => {
  assert(
    rebuildError === null,
    `rebuild threw: ${rebuildError && rebuildError.message}`,
  );
  assertEqual(result.intentsReplayed, OUT_OF_ORDER_INTENTS.length, 'intents replayed');
});

check('2. every intent JSON file is byte-identical after the rebuild', () => {
  const problems = diffSnapshots(before, after);
  assert(problems.length === 0, `intent files changed on disk:\n  ${problems.join('\n  ')}`);
});

check('3. the DB holds every requirement the intent files declare', () => {
  for (const intent of OUT_OF_ORDER_INTENTS) {
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
finish('rebuild-out-of-order');
