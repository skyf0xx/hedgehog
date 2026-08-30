#!/usr/bin/env node
// Repro: `hedgehog status --brief` answers one question in one line.
//
// `hedgehog-daily` runs its entry check before every change request,
// including the ones that end in a two-line edit, so that check must not
// pay for the full graph report. `--brief` prints the in-flight verdict
// and nothing else — no READY list, no counts block, no core-drift or
// commit-gate sections — while the default `status` report keeps every
// one of them.
//
// Expected: exit 0 on both paths; --brief names the in-flight task when
// a lease is outstanding, says nothing is in flight when none is, and in
// neither case prints a section the full report carries.

import {
  makeProject,
  completeNextTask,
  runCli,
  cleanup,
  checkExit,
  checkContains,
  check,
  report,
} from './lib/fixture.mjs';

const project = makeProject();
try {
  // Nothing claimed yet: the graph is planned, so the full report has
  // plenty to say and --brief has one thing.
  const idle = runCli(project, ['status', '--brief']);
  console.log('--- status --brief (idle)\n' + idle.stdout);

  checkExit('--brief exits 0 with nothing in flight', 0, idle);
  checkContains('--brief reports nothing in flight', 'IN FLIGHT  0', idle.stdout);
  check('--brief is one line', { expected: 1, actual: idle.stdout.trim().split('\n').length });
  check('--brief omits the counts block', { expected: false, actual: idle.stdout.includes('TASKS') });
  check('--brief omits the ready list', { expected: false, actual: idle.stdout.includes('READY') });

  // The full report still carries what --brief drops.
  const full = runCli(project, ['status']);
  checkExit('the default report still exits 0', 0, full);
  checkContains('the default report still prints the counts block', 'TASKS', full.stdout);
  checkContains('the default report still prints the ready list', 'READY', full.stdout);

  completeNextTask(project); // ALPHA-MODEL
  const claimed = runCli(project, ['claim', '--owner', 'agent-7']);
  console.log('--- claim\n' + claimed.stdout);

  const busy = runCli(project, ['status', '--brief']);
  console.log('--- status --brief (in flight)\n' + busy.stdout);

  checkExit('--brief exits 0 with work in flight', 0, busy);
  checkContains('--brief counts the in-flight task', 'IN FLIGHT  1', busy.stdout);
  checkContains('--brief names the in-flight task', 'ALPHA-VIEW', busy.stdout);
  check('--brief is still one line', { expected: 1, actual: busy.stdout.trim().split('\n').length });
} finally {
  cleanup(project);
}

report('status-brief-one-line');
