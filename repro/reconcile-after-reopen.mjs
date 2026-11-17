// Reconciliation after reopening must replace provenance and survive rebuild.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, addIntent, cli, taskStatuses, rebuildFromScratch, cleanup, check, checkContains, report } from './_lib.mjs';

const CORE = `
id: reconcile-reopen-fixture
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
const dir = makeProject(CORE, { git: true });
function commit(message) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}
try {
  addIntent(dir, 'alpha');
  check('plan', 0, cli(dir, ['plan']).status);
  mkdirSync(join(dir, 'libs/alpha/schema'), { recursive: true });
  writeFileSync(join(dir, 'libs/alpha/schema/model.txt'), 'first version\n');
  commit('hand-written first schema');
  check('first confirmation', 0, cli(dir, ['reconcile', 'confirm', 'ALPHA-SCHEMA', '--reason', 'first implementation']).status);
  check('dependent unlocked', 'ready', taskStatuses(dir)['ALPHA-API']);
  const recordPath = join(dir, '.hedgehog/reconciled/alpha-schema.json');
  const first = JSON.parse(readFileSync(recordPath, 'utf8'));
  check('complete task refuses confirmation', 1, cli(dir, ['reconcile', 'confirm', 'ALPHA-SCHEMA', '--reason', 'not reopened']).status);
  check('reopen', 0, cli(dir, ['reopen', 'ALPHA-SCHEMA', '--confirm']).status);
  const marker = join(dir, '.hedgehog/reopened/alpha-schema.json');
  check('reopen marker exists', true, existsSync(marker));
  check('reopened task planned', 'planned', taskStatuses(dir)['ALPHA-SCHEMA']);
  writeFileSync(join(dir, 'libs/alpha/schema/model.txt'), 'corrected version\n');
  commit('hand-fix schema after reopening');
  const proposal = cli(dir, ['reconcile']);
  check('proposal succeeds', 0, proposal.status);
  checkContains('reopened task proposed', proposal.stdout, 'ALPHA-SCHEMA');
  check('second confirmation', 0, cli(dir, ['reconcile', 'confirm', 'ALPHA-SCHEMA', '--reason', 'corrected implementation']).status);
  const second = JSON.parse(readFileSync(recordPath, 'utf8'));
  check('record reason replaced', 'corrected implementation', second.reason);
  check('new evidence includes corrected path', true, second.evidence.paths.includes('libs/alpha/schema/model.txt'));
  check('record timestamp present', true, Boolean(second.confirmed_at));
  check('reopen marker cleared', false, existsSync(marker));
  check('task complete again', 'complete', taskStatuses(dir)['ALPHA-SCHEMA']);
  check('dependent unlocked again', 'ready', taskStatuses(dir)['ALPHA-API']);
  check('rebuild', 0, rebuildFromScratch(dir).status);
  check('rebuild preserves completion', 'complete', taskStatuses(dir)['ALPHA-SCHEMA']);
  check('rebuild preserves dependent readiness', 'ready', taskStatuses(dir)['ALPHA-API']);
  check('without another reopen repeat refuses', 1, cli(dir, ['reopen', 'ALPHA-SCHEMA', '--confirm']).status === 0 ? 0 : 1);
  check('repeat confirmation while complete refuses', 1, cli(dir, ['reconcile', 'confirm', 'ALPHA-SCHEMA', '--reason', 'duplicate']).status);
} finally {
  cleanup(dir);
}
report('reconcile, reopen, correct, reconcile again, rebuild');
