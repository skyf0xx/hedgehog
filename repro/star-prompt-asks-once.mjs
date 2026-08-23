// Reproduction: the star prompt's one hard guarantee — it asks once, and
// any answer ends it.
//
// The prompt stops the Loop, which is the whole reason it works and also
// the whole reason a bug here is expensive: a prompt that re-fires blocks
// every subsequent intent completion on a question the user already
// answered. So the properties worth pinning are the ones that keep it
// from ever asking twice:
//
//   A. It fires at the first completed intent, and not before one.
//   B. `starred` and `dismissed` are terminal — never asked again.
//   C. `later` defers rather than repeats, and comes back after the
//      cooldown rather than never.
//   D. An unreadable state file reads as "never asked" rather than
//      "already answered". Failing toward one extra ask is recoverable;
//      failing toward silence means the question is never put at all.
//   E. An *unanswered* prompt defers itself. Recording only the answer
//      would leave the ignored case — agent prints the prompt, user says
//      keep going, nothing runs `community star` — re-firing at every
//      later intent completion.
//
// Runs entirely inside a temp dir.

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldPromptForStar, recordStarAnswer } from '../src/db/community.mjs';
import { check, assert, finish } from './harness.mjs';

console.log('repro: the star prompt asks once and any answer ends it\n');

const root = await mkdtemp(join(tmpdir(), 'hedgehog-star-'));
await mkdir(join(root, '.hedgehog'), { recursive: true });
console.log(`  temp project: ${root}\n`);

const statePath = join(root, '.hedgehog', 'community.json');
const fires = (intentComplete = true) => shouldPromptForStar(root, { intentComplete });

// A fresh project for each case: these are properties of the state file,
// and a case that inherited the previous one's answer would pass for the
// wrong reason.
const reset = () => writeFile(statePath, '{}\n');

// --- A. fires at the first completed intent, and only then ------------

await check('A. silent until an intent completes, then fires', async () => {
  await reset();
  assert(!(await fires(false)), 'fired with no intent complete');
  assert(await fires(true), 'did not fire at the first completed intent');
});

// --- B. starred and dismissed are terminal ----------------------------

for (const answer of ['starred', 'dismissed']) {
  await check(`B. "${answer}" is terminal`, async () => {
    await reset();
    assert(await fires(), 'did not fire before answering');
    await recordStarAnswer(root, answer);
    assert(!(await fires()), `asked again after "${answer}"`);

    // Terminal means terminal regardless of elapsed time — the cooldown
    // is a property of "later" alone.
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.deferredAt = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
    await writeFile(statePath, JSON.stringify(state));
    assert(!(await fires()), `"${answer}" expired like a deferral`);
  });
}

// --- C. later defers, then returns ------------------------------------

await check('C. "later" defers, and returns after the cooldown', async () => {
  await reset();
  await recordStarAnswer(root, 'later');
  assert(!(await fires()), 'asked again immediately after "later"');

  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.deferredAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  await writeFile(statePath, JSON.stringify(state));
  assert(await fires(), 'never came back after the cooldown elapsed');
});

await check('C. a corrupt deferral timestamp stays silent', async () => {
  await writeFile(statePath, JSON.stringify({ starPrompt: 'later', deferredAt: 'not-a-date' }));
  assert(!(await fires()), 'an unparseable deferral re-asked on every verify');
});

// --- D. an unreadable state file reads as "never asked" ---------------

await check('D. a corrupt state file asks rather than falling silent', async () => {
  await writeFile(statePath, '{ not json');
  assert(await fires(), 'a corrupt state file suppressed the prompt entirely');
});

// A write that cannot land must not throw: this rides on the back of a
// green verify, and a failed courtesy write turning a passing gate into a
// crash is strictly worse than asking once more later.
await check('D. recording into a missing project never throws', async () => {
  await recordStarAnswer(join(root, 'does', 'not', 'exist'), 'dismissed');
});

// --- E. an unanswered prompt defers itself ----------------------------

await check('E. showing the prompt defers it even with no answer', async () => {
  await reset();
  assert(await fires(), 'did not fire on the first completed intent');
  assert(!(await fires()), 're-fired at the next intent with no answer recorded');
  assert(!(await fires()), 're-fired at the third intent with no answer recorded');
});

await check('E. an answer still overrides a self-deferral', async () => {
  await reset();
  await fires(); // shown, unanswered
  await recordStarAnswer(root, 'starred');
  assert(!(await fires()), 'asked again after answering a shown prompt');

  // And the deferral is a cooldown, not a permanent silence: an ignored
  // prompt comes back once, where a terminal answer never does.
  await reset();
  await fires();
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.deferredAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  await writeFile(statePath, JSON.stringify(state));
  assert(await fires(), 'an ignored prompt never came back at all');
});

finish('star-prompt-asks-once');
