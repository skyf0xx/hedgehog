// Reproduction: a failed intent-file write must not strand the intent in
// the derived database.
//
// `addIntent` inserts before it writes, so that a record the DB rejects
// never reaches the permanent record. Done naively that trades one
// asymmetry for its mirror image: the insert commits, the file write
// fails, and the intent now exists ONLY in `.hedgehog/hedgehog.db` —
// which is gitignored and derived. The command reports failure, a retry
// hits the PRIMARY KEY constraint, and `db rebuild` can't recover the
// intent because it was never written to the record it replays from.
// That is a dead end for the user.
//
// The lever is an unwritable intents directory (chmod 0555): `writeFile`
// fails with EACCES after the inserts have run.
//
// Asserts:
//   1. the add fails loudly
//   2. NOTHING is left in the DB — no intents row, no requirements rows
//   3. retrying the identical add once the directory is writable SUCCEEDS
//      rather than hitting the PRIMARY KEY constraint
//   4. the permanent record then holds the intent in full
//   5. a rebuild from a deleted DB reconstructs it
//   6. no partial or temp file is left behind, and the intent files that
//      were already committed are byte-identical throughout
//
// Runs entirely inside a temp dir created by the harness.

import { chmod, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addIntent } from '../src/db/intent.mjs';
import { rebuildDb } from '../src/db/rebuild.mjs';
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

console.log('repro: a failed intent-file write must not strand the intent in the DB\n');

if (process.getuid && process.getuid() === 0) {
  console.log('  running as root — chmod cannot make a directory unwritable.');
  console.log('  This reproduction needs an unprivileged user.');
  process.exit(1);
}

const seed = intentFixture({ id: 'board', rules: 4, constraints: 1, acceptance: 1 });
// The intent whose file write is going to fail.
const ledger = intentFixture({ id: 'ledger', dependsOn: ['board'], rules: 7, constraints: 2, acceptance: 1 });

const root = await makeProject([seed]);
const intentsDir = join(root, '.hedgehog', 'intents');
console.log(`  temp project: ${root}`);
console.log(`  adding "ledger" (${ledger.requirements.length} requirements) with the intents dir unwritable\n`);

await dbInit(DB_PATH);
const db = openDb();

// `board` must already be in the DB for ledger's depends_on FK.
await addIntent(db, seed);
const afterSeed = await snapshotIntents(root);

// --- 1/2. the strand -------------------------------------------------

await chmod(intentsDir, 0o555);

let writeError = null;
try {
  await addIntent(db, ledger);
} catch (err) {
  writeError = err;
}

const intentRow = db.prepare('SELECT id FROM intents WHERE id = ?').get('ledger');
const requirementCount = db
  .prepare('SELECT COUNT(*) AS n FROM requirements WHERE intent_id = ?')
  .get('ledger').n;
const dependencyCount = db
  .prepare('SELECT COUNT(*) AS n FROM intent_dependencies WHERE intent_id = ?')
  .get('ledger').n;

await chmod(intentsDir, 0o755);

console.log(`  add error:            ${writeError ? writeError.message : '(none)'}`);
console.log(`  intents row for ledger: ${intentRow ? 'PRESENT  <-- STRANDED' : 'absent'}`);
console.log(`  requirements rows:      ${requirementCount}`);
console.log(`  intent_dependencies:    ${dependencyCount}`);
console.log('');

check('1. the add fails loudly', () => {
  assert(writeError !== null, 'expected the add to fail when the intents dir is unwritable');
  assert(
    /EACCES|permission denied/i.test(writeError.message),
    `expected a write error, got: ${writeError.message}`,
  );
});

check('2. a failed file write leaves nothing behind in the DB', () => {
  assert(
    intentRow === undefined,
    'the intents row survived a failed file write — the intent is stranded in the derived DB, ' +
      'invisible to `db rebuild` and un-retryable through `intent add`',
  );
  assertEqual(requirementCount, 0, 'stranded requirements rows');
  assertEqual(dependencyCount, 0, 'stranded intent_dependencies rows');
});

// --- 3/4. the retry is not a dead end --------------------------------

let retryError = null;
try {
  await addIntent(db, ledger);
} catch (err) {
  retryError = err;
}

check('3. retrying the identical add succeeds once the write can land', () => {
  assert(
    retryError === null,
    `the retry failed: ${retryError && retryError.message}` +
      (retryError && /UNIQUE|PRIMARY KEY/i.test(retryError.message)
        ? '  <-- dead end: the first attempt claimed the id and the record never got it'
        : ''),
  );
});

check('4. the permanent record then holds the intent in full', () => {
  const onDisk = JSON.parse(readFileSync(join(intentsDir, 'ledger.json'), 'utf8'));
  assertEqual(onDisk.requirements.length, ledger.requirements.length, 'requirements on disk');
  assertEqual(
    JSON.stringify(onDisk.depends_on),
    JSON.stringify(ledger.depends_on),
    'depends_on on disk',
  );
});

// --- 5. the record is authoritative ----------------------------------

const beforeRebuild = await snapshotIntents(root);
db.close();

// Throw the derived artifact away entirely, exactly as a fresh clone
// (or bin/cli.mjs#ensureDb) would find it.
for (const suffix of ['', '-wal', '-shm']) {
  await rm(join(root, `.hedgehog/hedgehog.db${suffix}`), { force: true });
}
await dbInit(DB_PATH);
const freshDb = openDb();
const rebuildResult = await rebuildDb(freshDb, { corePath: '.hedgehog/core.yaml' });
const rebuiltRequirements = freshDb
  .prepare('SELECT COUNT(*) AS n FROM requirements WHERE intent_id = ?')
  .get('ledger').n;

check('5. a rebuild reconstructs the intent from the permanent record', () => {
  assertEqual(rebuildResult.intentsReplayed, 2, 'intents replayed');
  assertEqual(rebuiltRequirements, ledger.requirements.length, 'ledger requirements after rebuild');
});

const afterRebuild = await snapshotIntents(root);
const strayFiles = (await readdir(intentsDir)).filter((n) => !n.endsWith('.json'));

check('6a. no partial or temp file is left in the intents directory', () => {
  assert(strayFiles.length === 0, `stray files left behind: ${strayFiles.join(', ')}`);
});

check('6b. the already-committed intent files are byte-identical throughout', () => {
  for (const [label, snapshot] of [
    ['after the failed write / retry', beforeRebuild],
    ['after the rebuild', afterRebuild],
  ]) {
    const problems = diffSnapshots(
      new Map([['board.json', afterSeed.get('board.json')]]),
      new Map([['board.json', snapshot.get('board.json')]]),
    );
    assert(problems.length === 0, `board.json changed ${label}:\n  ${problems.join('\n  ')}`);
  }
});

freshDb.close();
finish('add-intent-write-failure');
