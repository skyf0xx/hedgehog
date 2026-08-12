#!/usr/bin/env node
// Repro: `hedgehog plan` starts a graph server nobody asked for.
//
// Before the fix, any `plan` run that compiled at least one intent
// called startOrReuseGraphServer() unconditionally: a detached `node`
// process left listening on 127.0.0.1 with an open handle on the build
// graph, plus a `.hedgehog/graph-server.json` pidfile that outlives the
// command. `hedgehog graph` had `--no-open`; `plan` had no flag at all.
//
// Asserts, against the real CLI in a throwaway repo:
//   1. `plan --no-open` is accepted (exit 0, flag not an error);
//   2. it writes no .hedgehog/graph-server.json;
//   3. it leaves no graph-server process behind;
//   4. plain `plan`, with no flag at all, does the same — headless is
//      the normal case, so starting a server is opt-in;
//   5. `plan --open` still starts one (the escape hatch works), and is
//      cleaned up here.
//
// Run: node repro/plan-no-open.mjs

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkContains, cleanup, finish, graphServerPids, hedgehog, makeProject } from './papercuts-lib.mjs';

const CORE = `id: demo
layers:
  - id: infra
    scope: ["infra/{module}/**"]
    verify: "true"
    commit: "feat(infra): {module}"
`;

const project = makeProject(CORE);
const pidfile = join(project, '.hedgehog', 'graph-server.json');

// A tiny wait so a server that *was* spawned has certainly appeared in
// the process table before we claim it didn't.
function settle(ms = 400) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

try {
  console.log(`repro: plan --no-open   (${project})`);

  hedgehog(project, ['intent', 'add', '--id', 'alpha', '--goal', 'g', '--outcome', 'o']);

  // ── 1-3. plan --no-open ─────────────────────────────────────────────
  const noOpen = hedgehog(project, ['plan', '--no-open']);
  settle();

  check('plan --no-open exits 0', noOpen.status === 0, {
    expected: 'exit 0',
    actual: `exit ${noOpen.status}: ${noOpen.all.trim().slice(0, 400)}`,
  });
  checkContains('plan --no-open still compiles the intent', noOpen.all, 'compiled');
  check('plan --no-open is not rejected as an unknown flag', !noOpen.all.includes('Usage:'), {
    expected: 'no usage error',
    actual: noOpen.all.trim().slice(0, 400),
  });
  check('plan --no-open writes no graph-server pidfile', !existsSync(pidfile), {
    expected: `${pidfile} absent`,
    actual: `${pidfile} exists`,
  });
  const afterNoOpen = graphServerPids(project);
  check('plan --no-open leaves no graph-server process', afterNoOpen.length === 0, {
    expected: 'no graph-server process for this project',
    actual: `pids ${afterNoOpen.join(', ')}`,
  });

  // ── 4. bare plan, second intent so something compiles again ─────────
  hedgehog(project, ['intent', 'add', '--id', 'beta', '--goal', 'g', '--outcome', 'o']);
  const bare = hedgehog(project, ['plan']);
  settle();

  check('bare plan exits 0', bare.status === 0, {
    expected: 'exit 0',
    actual: `exit ${bare.status}: ${bare.all.trim().slice(0, 400)}`,
  });
  check('bare plan writes no graph-server pidfile', !existsSync(pidfile), {
    expected: `${pidfile} absent`,
    actual: `${pidfile} exists`,
  });
  const afterBare = graphServerPids(project);
  check('bare plan leaves no graph-server process', afterBare.length === 0, {
    expected: 'no graph-server process for this project',
    actual: `pids ${afterBare.join(', ')}`,
  });

  // ── 5. --open is the opt-in escape hatch ────────────────────────────
  hedgehog(project, ['intent', 'add', '--id', 'gamma', '--goal', 'g', '--outcome', 'o']);
  const opened = hedgehog(project, ['plan', '--open'], { HEDGEHOG_FORCE_HEADLESS: '1' });
  settle();

  check('plan --open exits 0', opened.status === 0, {
    expected: 'exit 0',
    actual: `exit ${opened.status}: ${opened.all.trim().slice(0, 400)}`,
  });
  check('plan --open does start a graph server', existsSync(pidfile), {
    expected: `${pidfile} exists`,
    actual: `${pidfile} absent`,
  });
  checkContains('plan --open prints the URL when there is no display', opened.all, 'http://localhost:');
} finally {
  cleanup(project);
}

finish('plan-no-open');
