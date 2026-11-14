// A friction record's file name is a hash of its logged_at and note, so two
// `friction add` calls with the same note in the same millisecond would
// write the same file and one entry would overwrite the other. `addFriction`
// moves logged_at forward until the key is free: both entries keep a record.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../src/db/schema.mjs';
import { addFriction, loadFrictionRecords } from '../src/db/friction.mjs';
import { cleanup, check, report } from './_lib.mjs';

const dir = mkdtempSync(join(tmpdir(), 'hedgehog-friction-key-'));
const realNow = Date.now;
try {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  const frictionDir = join(dir, '.hedgehog/friction');

  const frozen = realNow();
  Date.now = () => frozen;
  await addFriction(db, { note: 'same note' }, frictionDir);
  await addFriction(db, { note: 'same note' }, frictionDir);
  Date.now = realNow;

  check('two entries, two record files', 2, readdirSync(frictionDir).filter((n) => n.endsWith('.json')).length);
  check('two entries, two loaded records', 2, (await loadFrictionRecords(frictionDir)).size);
  check('two entries, two rows', 2, db.prepare('SELECT COUNT(*) AS n FROM friction').get().n);
  db.close();
} finally {
  Date.now = realNow;
  cleanup(dir);
}

report('two friction entries with the same note in the same millisecond keep separate records');
