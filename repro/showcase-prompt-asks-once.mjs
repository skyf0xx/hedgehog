// Reproduction: the showcase prompt's own guarantees, parallel to
// repro/star-prompt-asks-once.mjs for the star prompt.
//
// The showcase prompt is a second, independent ask on top of the star
// prompt, and the one property unique to it — never sharing the star
// prompt's "asks once" behavior would be almost as bad — is the gate: it
// must never fire before the star question has an answer (or at least a
// deferral) recorded in the same pass. Firing both blocking prompts on
// one verify call would stack two interruptions instead of one at a
// time, and firing showcase first would present the "optional" ask
// before the "please star" one even has a resolution.
//
// So the properties worth pinning are:
//
//   A. Silent when the star prompt has never been shown at all — no
//      `starPrompt` key in state.
//   B. Fires once the star prompt has an answer — a terminal one
//      (`starred`/`dismissed`) or a deferral (`later`, or an unanswered
//      `shown`) — same verify pass or a later one.
//   C. `shared` and `dismissed` are terminal for the showcase prompt —
//      never asked again.
//   D. `later` defers, then returns after the shared cooldown constant.
//   E. An unreadable state file reads as "never asked" rather than
//      "already answered" — same fail-open direction as the star prompt.
//   F. A write that cannot land never throws.
//   G. An unanswered showcase prompt defers itself, just like the star
//      prompt's own self-deferral.
//
// Runs entirely inside a temp dir.

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shouldPromptForShowcase,
  recordShowcaseAnswer,
  recordStarAnswer,
} from '../src/db/community.mjs';
import { check, assert, finish } from './harness.mjs';

console.log('repro: the showcase prompt gates on the star answer and asks once\n');

const root = await mkdtemp(join(tmpdir(), 'hedgehog-showcase-'));
await mkdir(join(root, '.hedgehog'), { recursive: true });
console.log(`  temp project: ${root}\n`);

const statePath = join(root, '.hedgehog', 'community.json');
const fires = (intentComplete = true) => shouldPromptForShowcase(root, { intentComplete });

// A fresh project for each case, with the star prompt already answered
// (unless the case is specifically testing the gate) — these are
// properties of the showcase prompt's own state, not the star prompt's.
const reset = async (starAnswer = 'dismissed') => {
  await writeFile(statePath, '{}\n');
  if (starAnswer !== null) await recordStarAnswer(root, starAnswer);
};

// --- A. silent until the star prompt has an answer ---------------------

await check('A. never fires with no starPrompt key at all', async () => {
  await writeFile(statePath, '{}\n');
  assert(!(await fires(false)), 'fired with no intent complete and no star answer');
  assert(!(await fires(true)), 'fired before the star prompt had ever been shown');
});

await check('A. silent even with intentComplete when starPrompt is unset', async () => {
  await writeFile(statePath, JSON.stringify({ showcasePrompt: undefined }));
  assert(!(await fires()), 'fired with starPrompt still unset');
});

// --- B. fires once the star prompt has an answer or a deferral ---------

for (const starAnswer of ['starred', 'dismissed', 'later']) {
  await check(`B. fires once the star prompt is "${starAnswer}"`, async () => {
    await reset(starAnswer);
    assert(await fires(), `did not fire after star prompt answered "${starAnswer}"`);
  });
}

await check('B. fires once the star prompt is merely "shown" (deferred, unanswered)', async () => {
  await writeFile(statePath, JSON.stringify({ starPrompt: 'shown', deferredAt: new Date().toISOString() }));
  assert(await fires(), 'did not fire once the star prompt was shown, even unanswered');
});

await check('B. does not fire on intentComplete: false even with a star answer', async () => {
  await reset('dismissed');
  assert(!(await fires(false)), 'fired with no intent complete');
});

// --- C. shared and dismissed are terminal -------------------------------

for (const answer of ['shared', 'dismissed']) {
  await check(`C. "${answer}" is terminal`, async () => {
    await reset('dismissed');
    assert(await fires(), 'did not fire before answering');
    await recordShowcaseAnswer(root, answer);
    assert(!(await fires()), `asked again after "${answer}"`);

    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.showcaseDeferredAt = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
    await writeFile(statePath, JSON.stringify(state));
    assert(!(await fires()), `"${answer}" expired like a deferral`);
  });
}

// --- D. later defers, then returns after the cooldown -------------------

await check('D. "later" defers, and returns after the cooldown', async () => {
  await reset('dismissed');
  await recordShowcaseAnswer(root, 'later');
  assert(!(await fires()), 'asked again immediately after "later"');

  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.showcaseDeferredAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  await writeFile(statePath, JSON.stringify(state));
  assert(await fires(), 'never came back after the cooldown elapsed');
});

await check('D. a corrupt showcase deferral timestamp stays silent', async () => {
  await writeFile(
    statePath,
    JSON.stringify({ starPrompt: 'dismissed', showcasePrompt: 'later', showcaseDeferredAt: 'not-a-date' }),
  );
  assert(!(await fires()), 'an unparseable deferral re-asked on every verify');
});

// --- E. an unreadable state file reads as "never asked" -----------------
//
// Note this fails toward SILENCE here, unlike the star prompt's own
// fail-open-to-shown behavior — a corrupt file can't be read for
// starPrompt either, so the gate (A) legitimately can't tell the star
// question has been answered yet. That's the correct, conservative
// outcome: never showing showcase before star, even under corruption.

await check('E. a corrupt state file does not fire (gate depends on reading starPrompt)', async () => {
  await writeFile(statePath, '{ not json');
  assert(!(await fires()), 'a corrupt state file fired despite being unable to confirm a star answer');
});

await check('E. recording into a missing project never throws', async () => {
  await recordShowcaseAnswer(join(root, 'does', 'not', 'exist'), 'dismissed');
});

// --- F. an unanswered prompt defers itself -------------------------------

await check('F. showing the prompt defers it even with no answer', async () => {
  await reset('dismissed');
  assert(await fires(), 'did not fire once gated open');
  assert(!(await fires()), 're-fired at the next intent with no answer recorded');
  assert(!(await fires()), 're-fired at the third intent with no answer recorded');
});

await check('F. an answer still overrides a self-deferral', async () => {
  await reset('dismissed');
  await fires(); // shown, unanswered
  await recordShowcaseAnswer(root, 'shared', { repoUrl: 'https://example.com/x', core: 'full-stack-app' });
  assert(!(await fires()), 'asked again after answering a shown prompt');
});

finish('showcase-prompt-asks-once');
