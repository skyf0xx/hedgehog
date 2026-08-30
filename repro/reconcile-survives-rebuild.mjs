// `hedgehog reconcile` absorbs hand-written work into the build graph,
// and the confirmation survives `hedgehog db rebuild`.
//
// The scenario is the one the graph had no answer for: a user hand-codes
// a layer's work between sessions and commits it with their own message.
// `hedgehog verify` never ran, so the commit subject is not the one
// core.yaml declares — and `db rebuild`, which credits a task only when
// some commit subject matches its `commit_message` exactly, sees the work
// as absent. `hedgehog next` then points at work that is already done.
//
// What this asserts, in order:
//   1. bare `reconcile` proposes the task and changes nothing
//   2. `reconcile confirm` closes it, writes .hedgehog/reconciled/<id>.json,
//      and records the "not verified" provenance as an inheritable note
//   3. `status` says the task closed by reconciliation
//   4. a rebuild from a deleted DB replays the confirmation — without it
//      the rebuild silently reverts the reconciliation, which is the
//      failure this command exists to prevent
//   5. the provenance note is not duplicated by that replay

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeProject,
  addIntent,
  cli,
  openGraph,
  taskStatuses,
  rebuildFromScratch,
  cleanup,
  check,
  checkContains,
  report,
} from './_lib.mjs';

// A plain two-layer module-axis core: `schema` then `api`, so the
// reconciled task has a dependent whose readiness must be unlocked.
const CORE = `
id: reconcile-fixture
layers:
  - id: schema
    scope: ["libs/{module}/schema/**"]
    verify: "true"
    commit: "feat({module}): schema"
  - id: api
    depends_on: schema
    scope: ["apps/api/{module}/**"]
    verify: "true"
    commit: "feat({module}): api"
`;

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
}

const dir = makeProject(CORE, { git: true });
try {
  addIntent(dir, 'alpha');
  check('plan exits 0', 0, cli(dir, ['plan']).status);

  const before = taskStatuses(dir);
  check('ALPHA-SCHEMA starts open', true, ['planned', 'ready'].includes(before['ALPHA-SCHEMA']));

  // The hand-written work: a real file inside ALPHA-SCHEMA's compiled
  // scope, committed under the user's own message rather than the one
  // core.yaml declares for that layer.
  mkdirSync(join(dir, 'libs/alpha/schema'), { recursive: true });
  writeFileSync(join(dir, 'libs/alpha/schema/model.txt'), 'hand-written between sessions\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'add the alpha schema by hand']);

  // A rebuild cannot credit that commit — this is the gap, asserted
  // rather than assumed.
  check('db rebuild exits 0', 0, rebuildFromScratch(dir).status);
  check(
    'a hand-written commit is not credited by a rebuild',
    true,
    ['planned', 'ready'].includes(taskStatuses(dir)['ALPHA-SCHEMA']),
  );

  // 1. Bare `reconcile` proposes and changes nothing.
  const proposal = cli(dir, ['reconcile']);
  check('reconcile exits 0', 0, proposal.status);
  checkContains('it proposes the task', proposal.stdout, 'ALPHA-SCHEMA');
  checkContains('it names the in-scope path', proposal.stdout, 'libs/alpha/schema/model.txt');
  checkContains('it says nothing was changed', proposal.stdout, 'evidence only');
  check(
    'the task is still open after the proposal',
    true,
    ['planned', 'ready'].includes(taskStatuses(dir)['ALPHA-SCHEMA']),
  );

  // 2. Confirming one task closes it and writes the committed record.
  const confirmed = cli(dir, [
    'reconcile',
    'confirm',
    'ALPHA-SCHEMA',
    '--reason',
    'the schema landed in the hand-written commit',
  ]);
  check('reconcile confirm exits 0', 0, confirmed.status);
  check('ALPHA-SCHEMA is complete', 'complete', taskStatuses(dir)['ALPHA-SCHEMA']);
  check('its dependent is unlocked', 'ready', taskStatuses(dir)['ALPHA-API']);

  const recordPath = join(dir, '.hedgehog/reconciled/alpha-schema.json');
  check('the committed record exists', true, existsSync(recordPath));
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  check('the record names the task', 'ALPHA-SCHEMA', record.task);
  check(
    'the record carries the reason',
    'the schema landed in the hand-written commit',
    record.reason,
  );
  check(
    'the record carries the evidence path',
    ['libs/alpha/schema/model.txt'],
    record.evidence.paths,
  );

  // The provenance: an inheritable note saying no verify ran.
  {
    const db = openGraph(dir);
    try {
      const notes = db
        .prepare('SELECT task_id, note FROM decisions ORDER BY id')
        .all();
      check('one provenance note is recorded', 1, notes.length);
      check('it is attached to the reconciled task', 'ALPHA-SCHEMA', notes[0]?.task_id);
      checkContains(
        'it states the task was not verified',
        notes[0]?.note ?? '',
        'Closed by reconciliation, not verification',
      );
    } finally {
      db.close();
    }
  }

  // 3. Status surfaces the distinction.
  const status = cli(dir, ['status']);
  checkContains('status names the section', status.stdout, 'CLOSED BY RECONCILIATION');
  checkContains('status names the task', status.stdout, 'ALPHA-SCHEMA');

  // A second confirmation of the same task is refused rather than
  // silently overwriting the first record.
  const again = cli(dir, ['reconcile', 'confirm', 'ALPHA-SCHEMA', '--reason', 'again']);
  check('a repeat confirmation fails', 1, again.status);

  // 4. The centre of the design: the confirmation survives a rebuild.
  const rebuilt = rebuildFromScratch(dir);
  check('db rebuild after reconciling exits 0', 0, rebuilt.status);
  check(
    'the reconciled task is still complete after a rebuild',
    'complete',
    taskStatuses(dir)['ALPHA-SCHEMA'],
  );
  checkContains(
    'the rebuild reports the replay separately from verified completions',
    rebuilt.stdout,
    'closed by reconciliation, not verification',
  );

  // 5. The replay does not duplicate the provenance note.
  {
    const db = openGraph(dir);
    try {
      check(
        'the provenance note is not duplicated by the replay',
        1,
        db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n,
      );
    } finally {
      db.close();
    }
  }

  // A second rebuild does not compound it either.
  check('a second db rebuild exits 0', 0, rebuildFromScratch(dir).status);
  {
    const db = openGraph(dir);
    try {
      check(
        'a second rebuild still leaves exactly one note',
        1,
        db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n,
      );
    } finally {
      db.close();
    }
  }

  // `reconcile list` reads the committed records back.
  const listed = cli(dir, ['reconcile', 'list']);
  check('reconcile list exits 0', 0, listed.status);
  checkContains('it lists the reconciled task', listed.stdout, 'ALPHA-SCHEMA');
} finally {
  cleanup(dir);
}

report('hedgehog reconcile absorbs hand-written work and survives db rebuild');
