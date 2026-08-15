// Control. Unlike the others, this one passes both before and after the
// change — that is the point. A core with no `once: true` layer must
// compile to exactly the graph it compiled before: same tasks, same
// dependency rows, same requirement links, same intents table.
//
// The baseline in fixtures/shipped-cores-baseline.json is the compiled
// graph both shipped cores are expected to produce. Regenerate it with:
//   node --experimental-sqlite repro/05-shipped-cores-unchanged.mjs --write-baseline
// only after a deliberate edit to a shipped core.yaml, and only once the
// printed diff has been read line by line — the baseline is what proves an
// engine change compiles the same graph, so regenerating it to make a
// failure go away is how that proof gets thrown away.

import { readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProject, addIntent, cli, dumpGraph, cleanup, check, report, REPO_ROOT } from './_lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(HERE, 'fixtures/shipped-cores-baseline.json');
const WRITE = process.argv.includes('--write-baseline');

// Two intents, one depending on the other, so the cross-intent per-layer
// edges are exercised too — those are the rows most at risk from a change
// that filters layers.
function compileShippedCore(coreName) {
  const coreYaml = readFileSync(
    join(REPO_ROOT, 'repro/fixtures/cores', `${coreName}.core.yaml`),
    'utf8',
  );
  const dir = makeProject(coreYaml);
  try {
    addIntent(dir, 'users', { priority: 10 });
    const r = cli(dir, [
      'intent',
      'add',
      '--id',
      'orders',
      '--goal',
      'build orders',
      '--outcome',
      'orders works',
      '--priority',
      '20',
      '--rule',
      'an order always has a customer',
      '--depends-on',
      'users',
    ]);
    if (r.status !== 0) throw new Error(`intent add orders failed: ${r.stderr}`);
    const planned = cli(dir, ['plan']);
    if (planned.status !== 0) throw new Error(`plan failed: ${planned.stderr}`);
    return dumpGraph(dir);
  } finally {
    cleanup(dir);
  }
}

const actual = {
  'full-stack-app': compileShippedCore('full-stack-app'),
  'landing-page': compileShippedCore('landing-page'),
};

if (WRITE) {
  writeFileSync(BASELINE, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`wrote baseline to ${BASELINE}`);
  process.exit(0);
}

const expected = JSON.parse(readFileSync(BASELINE, 'utf8'));

for (const coreName of Object.keys(expected)) {
  check(`${coreName}: intents table unchanged`, expected[coreName].intents, actual[coreName].intents);
  check(`${coreName}: tasks unchanged`, expected[coreName].tasks, actual[coreName].tasks);
  check(
    `${coreName}: dependency rows unchanged`,
    expected[coreName].dependencies,
    actual[coreName].dependencies,
  );
  check(
    `${coreName}: requirement links unchanged`,
    expected[coreName].task_requirements,
    actual[coreName].task_requirements,
  );
}

report('05 — shipped cores (no once layer) compile identically');
