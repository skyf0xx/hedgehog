// Reproduction: `plan` re-raises the singular module-id advisory for the
// routes that never pass through `intent add`.
//
// The subtle part is which routes exist. `intent add` warns, and that
// covers the interactive path — but an intent id reaches the compiler by
// several others, none of which re-check:
//
//   * `hedgehog intent add --file <path.json>`
//   * a hand-written `.hedgehog/intents/*.json` committed directly
//   * `hedgehog db rebuild`, which replays every committed intent file
//
// On any of those a singular id is silent all the way to a scope
// violation at `hedgehog verify` — the expensive, late discovery the
// advisory exists to prevent. `plan` is where every route converges and
// the last point the fix is still one file rename.
//
// It stays a warning, never a refusal: the plural convention is a
// heuristic, so a gate would reject legitimately-singular modules like
// `billing` and `search`. These assertions pin that too — a later change
// to a hard gate breaks them deliberately.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeProject,
  cli,
  cleanup,
  check,
  checkContains,
  report,
  REPO_ROOT,
} from './_lib.mjs';

const shippedCore = (name) =>
  readFileSync(join(REPO_ROOT, 'src/golden-cores', name, 'core.yaml'), 'utf8');

// Writes the intent file directly, bypassing `intent add` entirely — the
// hand-written-file route, and what `db rebuild` replays.
function writeIntentFile(dir, id) {
  const intents = join(dir, '.hedgehog/intents');
  mkdirSync(intents, { recursive: true });
  writeFileSync(
    join(intents, `${id}.json`),
    `${JSON.stringify(
      {
        id,
        goal: `build ${id}`,
        outcome: `${id} works`,
        requirements: [
          { id: `${id.toUpperCase()}-ACCEPTANCE-1`, kind: 'acceptance', statement: 'it works' },
        ],
        depends_on: [],
        priority: 50,
      },
      null,
      2,
    )}\n`,
  );
}

console.log('repro: plan re-raises the singular module-id check\n');

// --- A. --file bypasses intent add's warning, plan catches it ---------

{
  const dir = makeProject(shippedCore('full-stack-app'));
  try {
    // Four ids: three singular, one plural. `orders` must not be flagged,
    // or the advisory is noise on correctly-named modules.
    for (const id of ['task', 'invoice', 'billing', 'orders']) {
      const file = join(dir, `${id}-input.json`);
      writeFileSync(
        file,
        `${JSON.stringify({
          id,
          goal: `build ${id}`,
          outcome: `${id} works`,
          acceptance: ['it works'],
        })}\n`,
      );
      const r = cli(dir, ['intent', 'add', '--file', file]);
      if (r.status !== 0) throw new Error(`intent add --file ${id} failed: ${r.stderr}`);
    }

    const planned = cli(dir, ['plan']);
    check('A1. plan succeeds — this is an advisory, not a gate', 0, planned.status);
    checkContains('A2. plan names how many ids tripped it', planned.stdout, '3 module ids look singular');
    checkContains('A3. it names task', planned.stdout, 'task');
    checkContains('A4. it names invoice', planned.stdout, 'invoice');
    checkContains('A5. it names billing', planned.stdout, 'billing');
    check(
      'A6. a plural id is not flagged',
      false,
      planned.stdout.includes('orders — scope'),
    );

    // One shared explanation for however many ids trip it — repeating the
    // whole per-intent block N times buries the list of names under it.
    check(
      'A7. the explanation appears once, not once per id',
      1,
      planned.stdout.split("every layer's scope").length - 1,
    );
    // The recovery is per-id, so those lines do repeat.
    check(
      'A8. a git mv line per flagged id',
      3,
      planned.stdout.split('git mv').length - 1,
    );
    checkContains('A9. it points at db rebuild to re-derive', planned.stdout, 'hedgehog db rebuild');
    checkContains(
      'A10. it says plainly this is a convention, not a rule',
      planned.stdout,
      'a naming convention, not a rule',
    );

    // Still warns on a re-plan that compiles nothing. The advisory's
    // window is "no work has landed yet", not "this run compiled it" —
    // keying on the latter would go silent exactly on the `db rebuild`
    // route (section B), which compiles the tasks itself.
    const again = cli(dir, ['plan']);
    check('A11. a re-plan still warns while no work has started', 0, again.status);
    checkContains(
      'A12. the advisory survives a run that compiled nothing',
      again.stdout,
      '3 module ids look singular',
    );
  } finally {
    cleanup(dir);
  }
}

// --- A2. the window closes once work has actually landed --------------

{
  const dir = makeProject(shippedCore('full-stack-app'), { git: true });
  try {
    const file = join(dir, 'task-input.json');
    writeFileSync(
      file,
      `${JSON.stringify({ id: 'task', goal: 'g', outcome: 'o', acceptance: ['a'] })}\n`,
    );
    if (cli(dir, ['intent', 'add', '--file', file]).status !== 0) throw new Error('add failed');
    if (cli(dir, ['plan']).status !== 0) throw new Error('plan failed');

    // Claiming the first task starts the work. A rename is a Correction
    // Protocol case from here, not a `git mv`, so repeating the advice
    // would be telling the operator to do something no longer safe.
    const claimed = cli(dir, ['claim', '--count', '1', '--owner', 'repro']);
    check('A13. claim succeeds', 0, claimed.status);

    const after = cli(dir, ['plan']);
    check('A14. the advisory stops once a task has been started', false, /singular/i.test(after.stdout));
  } finally {
    cleanup(dir);
  }
}

// --- B. a hand-written intent file, replayed by db rebuild ------------

{
  const dir = makeProject(shippedCore('full-stack-app'), { git: true });
  try {
    writeIntentFile(dir, 'task');
    const rebuilt = cli(dir, ['db', 'rebuild']);
    if (rebuilt.status !== 0) throw new Error(`db rebuild failed: ${rebuilt.stderr}`);
    // Nothing in the rebuild path passes through `intent add`, so this is
    // the first time the id is looked at.
    check('B1. rebuild itself does not warn', false, /singular/i.test(rebuilt.stdout));

    const planned = cli(dir, ['plan']);
    check('B2. plan succeeds', 0, planned.status);
    checkContains('B3. plan catches the replayed singular id', planned.stdout, 'Module id looks singular');
    checkContains('B4. singular phrasing for exactly one id', planned.stdout, 'so this compiles');
  } finally {
    cleanup(dir);
  }
}

// --- C. the advisory is scoped to module-axis cores -------------------

{
  // landing-page has no `{module}` in any layer's scope, so an id is
  // never substituted as a directory name and the convention has nothing
  // to say. Warning here would be pure noise.
  const dir = makeProject(shippedCore('landing-page'));
  try {
    const file = join(dir, 'landing-input.json');
    writeFileSync(
      file,
      `${JSON.stringify({ id: 'landing', goal: 'g', outcome: 'o', acceptance: ['a'] })}\n`,
    );
    const r = cli(dir, ['intent', 'add', '--file', file]);
    if (r.status !== 0) throw new Error(`intent add --file landing failed: ${r.stderr}`);

    const planned = cli(dir, ['plan']);
    check('C1. plan succeeds on landing-page', 0, planned.status);
    check('C2. no singular advisory on a core with no module axis', false, /singular/i.test(planned.stdout));
  } finally {
    cleanup(dir);
  }
}

report('plan re-raises the singular module-id advisory on every route');
