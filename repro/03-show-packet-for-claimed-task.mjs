#!/usr/bin/env node
// Gap 3: the packet is unreachable once a task is claimed.
//
// `claim` printed only the task id and lease expiry, and claiming moves
// the task to `building` — which takes it out of `next`'s readiness
// SELECT (status IN ('planned','ready') AND lease_owner IS NULL). So the
// ALLOWED SCOPE and VERIFICATION an agent is meant to be dispatched with
// existed only in the database. This asserts claim now prints the packet,
// and that `show` reprints it afterwards.

import { makeProject, hedgehog, hedgehogAllowFail, assert, assertIncludes, assertExcludes, runRepro } from './lib.mjs';

await runRepro('show prints the packet for an already-claimed task', async () => {
  const { dir, cleanup } = await makeProject();
  try {
    const claim = hedgehog(dir, ['claim', '--owner', 'ag1']);
    assertIncludes(claim.out, 'ALLOWED SCOPE', 'claim should print the packet, not just the id');
    assertIncludes(claim.out, 'src/alpha/schema.txt', "claim's packet should carry the scope globs");
    assertIncludes(claim.out, 'VERIFICATION', "claim's packet should carry the verify command");

    // next can no longer see it — this is what made the packet
    // unreachable through any other command.
    const next = hedgehogAllowFail(dir, ['next']);
    assertExcludes(next.out, 'ALLOWED SCOPE', 'next cannot show a claimed task');

    const show = hedgehog(dir, ['show', 'ALPHA-SCHEMA']);
    assertIncludes(show.out, 'TASK  ALPHA-SCHEMA', 'show should name the task');
    assertIncludes(show.out, 'BUILDING', 'show should report the real status, not READY');
    assertIncludes(show.out, 'ag1', 'show should name the lease holder');
    assertIncludes(show.out, 'ALLOWED SCOPE', 'show should print the allowed scope');
    assertIncludes(show.out, 'src/alpha/schema.txt', 'show should print the scope globs');
    assertIncludes(show.out, 'node verify.mjs', 'show should print the verification command');
    assertIncludes(show.out, 'alpha must be correct', "show should print the intent's rules");

    // It also works for a task that is not ready at all — the dependent
    // layer, still waiting on this one.
    const blockedPacket = hedgehog(dir, ['show', 'ALPHA-SERVICE']);
    assertIncludes(blockedPacket.out, 'PLANNED', 'show should report a planned task as planned');
    assertIncludes(
      blockedPacket.out,
      'Waiting on ALPHA-SCHEMA',
      'show should name the dependency a not-ready task is waiting on',
    );

    const missing = hedgehogAllowFail(dir, ['show', 'NO-SUCH-TASK']);
    assert(missing.code !== 0, 'show should exit non-zero for an unknown task id');
    assertIncludes(missing.out, 'No such task', 'show should say the id matched nothing');
  } finally {
    await cleanup();
  }
});
