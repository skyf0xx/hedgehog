// Reproduction: a genuine `depends_on` cycle across intent files.
//
// A dependency-ordered replay needs an answer for the case where no
// order exists. This asserts the failure is a clear, named cycle error
// rather than a FOREIGN KEY message, an infinite loop, or a partial
// replay — and, as always, that the intent files on disk are untouched.
//
// Runs entirely inside a temp dir created by the harness.

import { rebuildDb } from '../src/db/rebuild.mjs';
import { openDb, dbInit, DB_PATH } from '../src/db/init.mjs';
import {
  CYCLIC_INTENTS,
  makeProject,
  snapshotIntents,
  diffSnapshots,
  reportSnapshot,
  check,
  assert,
  finish,
} from './harness.mjs';

console.log('repro: rebuild reports a genuine depends_on cycle clearly\n');

const root = await makeProject(CYCLIC_INTENTS);
console.log(`  temp project: ${root}`);
console.log('  cycle: alpha -> gamma -> beta -> alpha\n');

const before = await snapshotIntents(root);
reportSnapshot('before rebuild:', before);
console.log('');

await dbInit(DB_PATH);
const db = openDb();

let rebuildError = null;
try {
  await rebuildDb(db, { corePath: '.hedgehog/core.yaml' });
} catch (err) {
  rebuildError = err;
}

const after = await snapshotIntents(root);
console.log(`  rebuild error: ${rebuildError ? rebuildError.message : '(none — rebuild succeeded)'}`);
console.log('');

check('1. rebuild fails with a cycle error naming the intents', () => {
  assert(rebuildError !== null, 'expected the rebuild to fail on a cycle');
  assert(
    /cycle/i.test(rebuildError.message),
    `error should name the cycle, got: ${rebuildError.message}`,
  );
  assert(
    /alpha|beta|gamma/.test(rebuildError.message),
    `error should name at least one intent in the cycle, got: ${rebuildError.message}`,
  );
});

check('2. every intent JSON file is byte-identical after the failed rebuild', () => {
  const problems = diffSnapshots(before, after);
  assert(problems.length === 0, `intent files changed on disk:\n  ${problems.join('\n  ')}`);
});

db.close();
finish('rebuild-cycle');
