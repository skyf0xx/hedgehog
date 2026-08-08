// Shared fixture for the `repro/` scripts: builds a throwaway Hedgehog
// project in a temp dir and drives the real CLI against it.
//
// No test framework and no `sqlite3` binary — assertions are plain
// throws, and the DB is read through node:sqlite (built in since Node
// 22.5; older builds need `node --experimental-sqlite`).

import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const CLI = join(REPO_ROOT, 'bin/cli.mjs');

// Two layers, module axis — the shape a real authored core has. The
// `foundation` layer's verify command is the one the scripts edit, since
// that mirrors the reported bug (a PATH fix on an infra layer's verify).
export const CORE_YAML_BEFORE = `id: repro-core
layers:
  - id: foundation
    scope: ["infra/{module}/**"]
    verify: node --test infra/{module}
    commit: "feat({module}): foundation"
  - id: api
    depends_on: foundation
    scope: ["apps/api/src/{module}/**"]
    verify: node --test apps/api/src/{module}
    commit: "feat({module}): api"
`;

// The correction: `foundation`'s verify gains the PATH prefix, and its
// scope widens to include the module's generated manifest.
export const VERIFY_BEFORE = 'node --test infra/billing';
export const VERIFY_AFTER = 'PATH=/usr/local/bin:$PATH node --test infra/billing';

export const CORE_YAML_AFTER = `id: repro-core
layers:
  - id: foundation
    scope: ["infra/{module}/**", "infra/{module}.manifest.json"]
    verify: PATH=/usr/local/bin:$PATH node --test infra/{module}
    commit: "feat({module}): foundation"
  - id: api
    depends_on: foundation
    scope: ["apps/api/src/{module}/**"]
    verify: node --test apps/api/src/{module}
    commit: "feat({module}): api"
`;

const projects = [];

// `hedgehog plan` starts a detached graph server and shells out to the
// OS "open" handler when it compiles anything. Neither belongs in a
// repro run, so each project gets a bin dir on PATH that shadows
// xdg-open/open/start with a no-op, and killGraphServer() reaps the
// server on cleanup.
function writeFakeOpeners(binDir) {
  mkdirSync(binDir, { recursive: true });
  for (const name of ['xdg-open', 'open', 'start']) {
    const path = join(binDir, name);
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
  }
}

function killGraphServer(dir) {
  const pidfile = join(dir, '.hedgehog/graph-server.json');
  if (!existsSync(pidfile)) return;
  try {
    const { pid } = JSON.parse(readFileSync(pidfile, 'utf8'));
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone, or never started — nothing to reap.
  }
}

export function makeProject(coreYaml = CORE_YAML_BEFORE) {
  const dir = mkdtempSync(join(tmpdir(), 'hedgehog-repro-'));
  const binDir = join(dir, '.fake-bin');
  writeFakeOpeners(binDir);
  mkdirSync(join(dir, '.hedgehog'), { recursive: true });
  writeFileSync(join(dir, '.hedgehog/core.yaml'), coreYaml);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    NO_COLOR: '1',
  };

  const project = {
    dir,
    writeCore(text) {
      writeFileSync(join(dir, '.hedgehog/core.yaml'), text);
    },
    run(...args) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
      return {
        code: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
      };
    },
    git(...args) {
      return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    },
    openDb() {
      return new DatabaseSync(join(dir, '.hedgehog/hedgehog.db'));
    },
    // Reads one task row. Used only to observe what `plan` wrote — the
    // scripts never patch layer-derived fields by hand, which is the
    // whole point.
    task(id) {
      const db = project.openDb();
      try {
        return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      } finally {
        db.close();
      }
    },
    // Moves a task into a lifecycle state the CLI would otherwise only
    // reach by running a real build + verify (which needs a toolchain
    // this repro deliberately doesn't have). Only `status`/lease columns
    // are touched, never the layer-derived fields under test.
    setStatus(id, status, owner = null) {
      const db = project.openDb();
      try {
        db.prepare(
          'UPDATE tasks SET status = ?, lease_owner = ?, lease_expires_at = ? WHERE id = ?',
        ).run(status, owner, owner ? '2999-01-01T00:00:00Z' : null, id);
      } finally {
        db.close();
      }
    },
    cleanup() {
      killGraphServer(dir);
      rmSync(dir, { recursive: true, force: true });
    },
  };

  projects.push(project);
  return project;
}

// A project with the "before" core.yaml, one intent, and `plan` already
// run — the state every scenario starts from.
export function plannedProject(intentId = 'billing') {
  const p = makeProject();
  p.git('init', '-q');
  mustSucceed(p.run('db', 'init'), 'hedgehog db init');
  mustSucceed(
    p.run('intent', 'add', '--id', intentId, '--goal', 'g', '--outcome', 'o'),
    'hedgehog intent add',
  );
  mustSucceed(p.run('plan'), 'hedgehog plan');
  return p;
}

export function cleanupAll() {
  for (const p of projects) p.cleanup();
}

// ── assertions ─────────────────────────────────────────────────────────
export class ReproFailure extends Error {}

export function mustSucceed(result, label) {
  if (result.code !== 0) {
    throw new ReproFailure(
      `${label} exited ${result.code}\n--- output ---\n${result.out}`,
    );
  }
  return result;
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new ReproFailure(
      `${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

export function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new ReproFailure(
      `${label}\n  expected output to contain: ${JSON.stringify(needle)}\n  actual output:\n${indent(haystack)}`,
    );
  }
}

export function assertNotIncludes(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new ReproFailure(
      `${label}\n  expected output NOT to contain: ${JSON.stringify(needle)}\n  actual output:\n${indent(haystack)}`,
    );
  }
}

function indent(text) {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

// Runs one named scenario, printing pass/fail and returning a boolean.
export function scenario(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    return true;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(indent(err.message));
    return false;
  }
}
