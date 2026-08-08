// Reproduction: the two properties of the write path that made the
// rebuild destructive in the first place, plus the safety net.
//
//   A. `normalizeIntent` must round-trip its OWN output. It writes
//      `requirements` but reads `rules`/`constraints`/`acceptance`, so
//      feeding a written intent file back through it yields zero
//      requirements. That asymmetry is what emptied the record.
//
//   B. `addIntent` must not write the intent file before the DB insert.
//      With write-first, an insert that fails leaves a rewritten (and
//      possibly emptied) permanent record behind with nothing in the DB
//      to show for it.
//
//   C. Overwriting a non-empty intent file with a zero-requirement one
//      must fail loudly rather than silently empty a committed record.
//
// Runs entirely inside a temp dir created by the harness.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeIntent, addIntent } from '../src/db/intent.mjs';
import { openDb, dbInit, DB_PATH } from '../src/db/init.mjs';
import {
  intentFixture,
  makeProject,
  snapshotIntents,
  diffSnapshots,
  check,
  assert,
  assertEqual,
  finish,
} from './harness.mjs';

console.log('repro: addIntent / normalizeIntent must not destroy a written record\n');

// 14 rules + 4 constraints + 4 acceptance = 22 requirements, the count
// the real project's `card` module lost.
const seed = intentFixture({ id: 'card', rules: 14, constraints: 4, acceptance: 4 });
const cardPath = () => join(root, '.hedgehog', 'intents', 'card.json');

const root = await makeProject([seed]);
console.log(`  temp project: ${root}`);
console.log(`  card.json carries ${seed.requirements.length} requirements\n`);

await dbInit(DB_PATH);
const db = openDb();

// --- A. normalizeIntent round-trips its own output --------------------

check('A. normalizeIntent round-trips its own output', () => {
  const fromInput = normalizeIntent({
    id: 'roundtrip',
    goal: 'g',
    outcome: 'o',
    rules: ['r1', 'r2'],
    constraints: ['c1'],
    acceptance: ['a1'],
  });
  assertEqual(fromInput.requirements.length, 4, 'requirements from the input shape');

  const again = normalizeIntent(fromInput);
  assertEqual(again.requirements.length, 4, 'requirements after re-normalizing the output shape');
  assertEqual(
    JSON.stringify(again.requirements),
    JSON.stringify(fromInput.requirements),
    'requirements should survive a round trip unchanged',
  );
});

check('A2. normalizeIntent preserves a real on-disk intent record', () => {
  assertEqual(
    normalizeIntent(JSON.parse(readFileSync(cardPath(), 'utf8'))).requirements.length,
    seed.requirements.length,
    'requirements after normalizing the committed file',
  );
});

// --- B. a failed DB insert must not have touched the file -------------

const beforeAdd = await snapshotIntents(root);
await addIntent(db, seed);
const afterAdd = await snapshotIntents(root);

check('B1. a successful add leaves the committed record byte-identical', () => {
  const problems = diffSnapshots(beforeAdd, afterAdd);
  assert(problems.length === 0, `add rewrote the record:\n  ${problems.join('\n  ')}`);
});

// `card` is now in the DB, so re-adding the same id hits the PRIMARY KEY
// constraint. The file must be untouched when the insert fails.
let duplicateError = null;
try {
  await addIntent(db, { id: 'card', goal: 'a different goal', outcome: 'o' });
} catch (err) {
  duplicateError = err;
}
const afterDuplicate = await snapshotIntents(root);

check('B2. a failed DB insert does not rewrite the intent file', () => {
  assert(duplicateError !== null, 'expected the duplicate-id add to fail');
  const problems = diffSnapshots(afterAdd, afterDuplicate);
  assert(
    problems.length === 0,
    `a failed insert still rewrote the intent file:\n  ${problems.join('\n  ')}`,
  );
});

// --- C. refuse to empty a non-empty record ----------------------------

// Drop the DB row so the insert would now succeed: only the file guard
// stands between a zero-requirement record and the committed 22.
db.exec("DELETE FROM intents WHERE id = 'card'");

let guardError = null;
try {
  await addIntent(db, { id: 'card', goal: 'g', outcome: 'o' });
} catch (err) {
  guardError = err;
}
const afterGuard = await snapshotIntents(root);
console.log(`  guard error: ${guardError ? guardError.message : '(none — the record was overwritten)'}`);
console.log('');

check('C1. refuses to overwrite a non-empty intent file with an empty one', () => {
  assert(
    guardError !== null,
    'expected addIntent to refuse emptying a committed record of 22 requirements',
  );
  assert(
    /requirement/i.test(guardError.message),
    `error should explain the refusal, got: ${guardError.message}`,
  );
});

check('C2. the record on disk still holds all 22 requirements', () => {
  const onDisk = JSON.parse(readFileSync(cardPath(), 'utf8'));
  assertEqual(onDisk.requirements.length, 22, 'requirements still on disk');
  const problems = diffSnapshots(afterAdd, afterGuard);
  assert(problems.length === 0, `record changed:\n  ${problems.join('\n  ')}`);
});

db.close();
finish('add-intent-safety');
