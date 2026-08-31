// Reproduction: the showcase prompt as `hedgehog verify` actually fires
// it, end to end through the real CLI — parallel to
// repro/star-prompt-engine-state.mjs, which covers the same ground for
// the star prompt alone.
//
// Three things only an integration test through the real binary can
// confirm:
//
//   1. Closing an intent's last layer with the star prompt still
//      unanswered shows the star prompt but NOT the showcase prompt in
//      that same verify output — the gate in shouldPromptForShowcase
//      (src/db/community.mjs) reads real on-disk state written by the
//      real `community star` subcommand, not a mock.
//   2. Once the star prompt is answered (`hedgehog community star
//      --answer ...`), the NEXT intent to close its last layer shows the
//      showcase prompt.
//   3. `.hedgehog/community.json` — now carrying both starPrompt and
//      showcasePrompt/showcaseDeferredAt/showcaseAnsweredAt keys — still
//      rides free of `verify`'s scope gate and `boundary`'s clean-tree
//      check, exactly as it did with the star prompt alone. This is the
//      "no isEngineStatePath change needed" acceptance criterion, proven
//      rather than just asserted: both isEngineStatePath functions match
//      COMMUNITY_PATH by exact whole-path equality, so any new key
//      inside that same file is invisible to both gates by construction
//      — this run demonstrates it holds with the showcase keys present.

import {
  makeProject,
  completeNextTask,
  writeScopeFile,
  runCli,
  runCliCapturingBoth,
  cleanup,
  check,
  checkExit,
  checkContains,
  report,
} from './lib/fixture.mjs';

const project = makeProject();
try {
  const alphaModel = completeNextTask(project); // ALPHA-MODEL
  const alphaViewResult = runCli(project, ['claim', '--owner', 'repro']);
  const match = alphaViewResult.stdout.match(/Task ([A-Z0-9-]+) leased/);
  if (!match) throw new Error(`fixture: nothing claimable\n${alphaViewResult.stdout}${alphaViewResult.stderr}`);
  const taskId = match[1];

  // Write ALPHA-VIEW's scope file by hand (rather than completeNextTask)
  // so the verify call's stdout can be captured and inspected directly.
  writeScopeFile(project, taskId);
  const verifyOut = runCli(project, ['verify', taskId, '--owner', 'repro']);

  check('closing alpha (first intent) exits 0', { expected: 0, actual: verifyOut.status });
  check('the star prompt fired on the first intent completion', {
    expected: true,
    actual: verifyOut.stdout.includes('STAR PROMPT'),
  });
  check('the showcase prompt did NOT fire in the same pass — star is unanswered', {
    expected: false,
    actual: verifyOut.stdout.includes('SHOWCASE PROMPT'),
  });

  check('alpha closed via ALPHA-MODEL + ALPHA-VIEW', {
    expected: 'ALPHA-VIEW',
    actual: taskId,
  });
  void alphaModel;

  // Answer the star prompt, the real way — through the subcommand a
  // human/agent would actually run.
  const starAnswer = runCli(project, ['community', 'star', '--answer', 'dismissed']);
  check('recording the star answer exits 0', { expected: 0, actual: starAnswer.status });

  // Closing beta's last layer is the next intent completion — this is
  // where the showcase prompt should appear for the first time.
  completeNextTask(project); // BETA-MODEL
  const betaViewClaim = runCli(project, ['claim', '--owner', 'repro']);
  const betaTaskId = betaViewClaim.stdout.match(/Task ([A-Z0-9-]+) leased/)?.[1];
  if (!betaTaskId) throw new Error(`fixture: nothing claimable for beta\n${betaViewClaim.stdout}`);
  writeScopeFile(project, betaTaskId);
  const betaVerifyOut = runCli(project, ['verify', betaTaskId, '--owner', 'repro']);

  check('closing beta (second intent) exits 0', { expected: 0, actual: betaVerifyOut.status });
  check('the showcase prompt fires once the star prompt has an answer', {
    expected: true,
    actual: betaVerifyOut.stdout.includes('SHOWCASE PROMPT'),
  });
  check('the star prompt does not fire again — already terminal', {
    expected: false,
    actual: betaVerifyOut.stdout.includes('STAR PROMPT'),
  });

  // Record the showcase answer too, through the real subcommand, so the
  // tree is in the state a real project would actually reach.
  const showcaseAnswer = runCli(project, ['community', 'showcase', '--answer', 'dismissed']);
  check('recording the showcase answer exits 0', { expected: 0, actual: showcaseAnswer.status });

  // boundary's clean-tree condition must still pass with both prompts'
  // state written into the same untouched community.json.
  const boundaryResult = runCliCapturingBoth(project, ['boundary']);
  checkExit('boundary exits 0 with both prompts\' state left uncommitted', 0, boundaryResult);
  checkContains(
    'clean-tree condition passes despite community.json carrying showcase keys too',
    'no uncommitted changes',
    boundaryResult.stderr,
  );
} finally {
  cleanup(project);
}

report('showcase-prompt-verify-integration');
