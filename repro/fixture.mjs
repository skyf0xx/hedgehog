// Shared fixture for the repro scripts: a throwaway git repo with a
// one-layer authored core, an intent compiled into a task, and that task
// claimed — the exact state a build agent hands to `hedgehog verify`.
//
// Everything lives inside a fresh `mkdtemp` directory. Nothing outside it
// is ever written or removed.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = resolve(HERE, '..', 'bin', 'cli.mjs');

export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

// Runs the real `hedgehog` CLI. A nonzero exit is a legitimate outcome
// (a scope violation or a failing verify_command is exit 1), so it is
// captured rather than thrown.
export function hedgehog(cwd, args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err.message),
    };
  }
}

// `hedgehog plan` spawns a detached graph-viewer server per project.
// These fixtures don't want one, and a repro run that leaves a dozen
// stray node processes behind is bad manners.
function stopGraphServer(repo) {
  const pidfile = join(repo, '.hedgehog', 'graph-server.json');
  // The detached server writes its own pidfile, which can land a moment
  // after `plan` returns — poll briefly rather than racing it.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const { pid } = JSON.parse(readFileSync(pidfile, 'utf8'));
      if (pid) {
        process.kill(pid);
        return;
      }
    } catch {
      // Not written yet, half-written, or the server is already gone.
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

// `scope` is spliced into core.yaml's inline-list syntax verbatim, so
// callers pass e.g. `src/**` or `src/**, docs/**`. `seed` is a map of
// repo-relative path -> contents committed before the task is claimed.
export function makeProject({ scope, verify = 'true', commit, seed = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'hedgehog-verify-repro-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.hedgehog'), { recursive: true });

  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'repro@example.invalid']);
  git(repo, ['config', 'user.name', 'repro']);
  git(repo, ['config', 'commit.gpgsign', 'false']);

  // The build graph, the commit lock and the graph-viewer pidfile are
  // engine state, gitignored in every real Hedgehog project. The pidfile
  // especially: the detached server rewrites and finally removes it on
  // its own schedule, so a tracked copy shows up as a spurious
  // working-tree change in whichever scenario happens to race it.
  writeFileSync(
    join(repo, '.gitignore'),
    '.hedgehog/hedgehog.db*\n.hedgehog/commit.lock\n.hedgehog/graph-server.json\n',
  );
  writeFileSync(
    join(repo, '.hedgehog', 'core.yaml'),
    [
      'id: repro',
      'layers:',
      '  - id: layer',
      `    scope: [${scope}]`,
      `    verify: ${verify}`,
      `    commit: ${commit}`,
      '',
    ].join('\n'),
  );
  writeFileSync(join(repo, 'README.md'), 'repro fixture\n');
  for (const [path, contents] of Object.entries(seed)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'chore: seed']);

  hedgehog(repo, ['db', 'init']);
  hedgehog(repo, ['intent', 'add', '--id', 'demo', '--goal', 'g', '--outcome', 'o']);
  hedgehog(repo, ['plan']);
  stopGraphServer(repo);

  // Real projects commit `.hedgehog/intents/*.json`; leaving them
  // untracked would trip the scope gate before verify reaches the code
  // under test.
  git(repo, ['add', '-A', '.hedgehog']);
  git(repo, ['commit', '-q', '-m', 'chore: intents']);

  const claim = hedgehog(repo, ['claim', '--owner', 'repro']);
  if (!/Claimed/.test(claim.stdout)) {
    throw new Error(`fixture setup failed: claim did not succeed\n${claim.stdout}${claim.stderr}`);
  }

  return { root, repo, taskId: 'DEMO-LAYER' };
}

// Minimal assertion harness — no test framework is available.
export function makeReporter() {
  const results = [];
  return {
    check(scenario, name, expected, actual) {
      const ok = JSON.stringify(expected) === JSON.stringify(actual);
      results.push({ scenario, name, expected, actual, ok });
      console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
      if (!ok) {
        console.log(`         expected: ${JSON.stringify(expected)}`);
        console.log(`         actual:   ${JSON.stringify(actual)}`);
      }
    },
    finish(passMessage, failMessage) {
      const failed = results.filter((r) => !r.ok);
      console.log('\n─────────────────────────────────────────────');
      console.log(`${results.length - failed.length}/${results.length} checks passed`);
      if (failed.length > 0) {
        console.log(`\n${failMessage}`);
        for (const f of failed) {
          console.log(`  scenario ${f.scenario}: ${f.name}`);
          console.log(`    expected: ${JSON.stringify(f.expected)}`);
          console.log(`    actual:   ${JSON.stringify(f.actual)}`);
        }
        process.exit(1);
      }
      console.log(passMessage);
    },
  };
}
