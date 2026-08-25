#!/usr/bin/env node
// An index describes the commit it was built from. Once the build moves
// past that commit, the pre-read context and the verify_radius gap check
// are both drawn from code as it was — and the gap check's failure is
// the quiet one: an empty suggestion list reads as "radius is complete"
// whether it is, or whether the index simply cannot see the files added
// since. That is a second source of truth drifting from the first, which
// is the failure Hedgehog exists to prevent, so the index carries the
// commit it indexed and the CLI checks that claim rather than trusting it.
//
// The four states this pins down, all of them advisory — a stale index
// never blocks a command, because stranding a build behind a multi-minute
// re-index is worse than proceeding with a caveat the operator can read:
//
//   fresh          indexedSha === HEAD          silent
//   stale          indexedSha !== HEAD          reported, command still runs
//   no-provenance  config without indexedSha    reported as unknown
//   no-config      no code intelligence at all  silent (setup gap owns it)

import { execFileSync } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assert,
  assertExcludes,
  assertIncludes,
  hedgehog,
  makeProject,
  runRepro,
} from './lib.mjs';

const CONFIG = '.hedgehog/code-intelligence.json';

// `/bin/echo` stands in for the CGC binary: the config must name
// something executable for the staleness path to render a usable command
// hint, and echo exits immediately rather than holding a pipe open the
// way a real MCP server would.
async function writeConfig(dir, extra) {
  await writeFile(
    join(dir, CONFIG),
    JSON.stringify({ command: '/bin/echo', args: ['mcp'], ...extra }, null, 2),
  );
}

const head = (dir) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

await runRepro('code intelligence: a stale index is reported, not enforced', async () => {
  const { dir, cleanup } = await makeProject();
  try {
    // --- fresh: indexed at the commit that is checked out ------------
    await writeConfig(dir, { indexedSha: head(dir), indexedAt: new Date().toISOString() });

    const fresh = hedgehog(dir, ['status']);
    assertExcludes(fresh.out, 'INDEX IS STALE', 'a fresh index says nothing');
    assertExcludes(fresh.out, 'AGE UNKNOWN', 'a fresh index is not unknown either');

    // --- stale: the build moves on, the index does not ---------------
    await writeFile(join(dir, 'added-after-indexing.txt'), 'code the index cannot see\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-q', '-m', 'feat: land code after indexing'], {
      cwd: dir,
      stdio: 'pipe',
    });

    const stale = hedgehog(dir, ['status']);
    assertIncludes(stale.out, 'INDEX IS STALE', 'a drifted index is reported');
    // The message names both commits, so the reader can see how far the
    // drift actually goes rather than being told only that it exists.
    assertIncludes(stale.out, head(dir).slice(0, 8), 'names the current HEAD');
    assertIncludes(stale.out, 'index .', 'names the command that refreshes it');

    // Advisory, not a gate: `plan` reports the drift and still compiles.
    // A project that cannot plan until it re-indexes is a project whose
    // build is held hostage by a cache.
    hedgehog(dir, ['intent', 'add', '--id', 'gamma', '--goal', 'build gamma', '--outcome', 'gamma works']);
    const planned = hedgehog(dir, ['plan']);
    assertIncludes(planned.out, 'INDEX IS STALE', 'plan reports the drift too');
    assertIncludes(planned.out, 'Plan complete', 'and compiles anyway');

    // --- no provenance: a config written before this field existed ---
    // Every 6.0.0-era config that predates `indexedSha` lands here. It is
    // not stale (nothing claims otherwise) and not fresh (nothing claims
    // that either) — the honest answer is that the age cannot be known.
    await writeConfig(dir, {});
    const unknown = hedgehog(dir, ['status']);
    assertIncludes(unknown.out, 'AGE UNKNOWN', 'a config with no indexedSha reports unknown');
    assertExcludes(unknown.out, 'INDEX IS STALE', 'unknown is not reported as stale');

    // --- no config: code intelligence was never set up ---------------
    // The setup gap message owns this case; a staleness notice on top of
    // it would be noise about an index that does not exist.
    await rm(join(dir, CONFIG));
    const none = hedgehog(dir, ['status']);
    assertExcludes(none.out, 'INDEX IS STALE', 'no config, no staleness notice');
    assertExcludes(none.out, 'AGE UNKNOWN', 'no config, no unknown-age notice');
    assert(true, 'absent config stays silent about index age');
  } finally {
    await cleanup();
  }
});
