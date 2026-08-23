// Shared harness for the `hedgehog db rebuild` data-loss reproductions.
//
// Everything here happens inside a freshly-created temp directory
// (`mkdtemp` under the OS temp dir). No reproduction ever touches a real
// project's `.hedgehog/` — the fixtures are written from scratch into a
// directory this file creates, and the process chdirs into it because
// `rebuildDb` resolves both the DB path and the intents directory
// relative to `process.cwd()`.
//
// No test framework and no `sqlite3` binary are available, so the
// assertions are plain functions and the DB is read through
// `node:sqlite` (Node >= 22.5).

import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------

const failures = [];

// Returns a promise when `fn` is async, so an async body must be awaited
// at the call site: `await check(...)`. A try/catch alone cannot see into
// a promise — a rejected assertion inside an async `fn` would leave the
// check printing PASS, surface as an unhandled rejection, and let
// `finish` exit 0 having recorded no failure. A reproduction that cannot
// fail is worse than no reproduction, so rejections are routed to the
// same failure path as a thrown assertion rather than left to chance.
export function check(label, fn) {
  const pass = () => {
    console.log(`  PASS  ${label}`);
  };
  const failed = (err) => {
    failures.push(`${label}: ${err.message}`);
    console.log(`  FAIL  ${label}`);
    console.log(`        ${err.message.split('\n').join('\n        ')}`);
  };

  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(pass, failed);
    }
    pass();
  } catch (err) {
    failed(err);
  }
  return undefined;
}

export function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

export function finish(name) {
  console.log('');
  if (failures.length === 0) {
    console.log(`${name}: OK`);
    process.exit(0);
  }
  console.log(`${name}: ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

// ---------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------

// A minimal module-axis core: two layers, trivial verify commands. The
// reproductions never run the verify commands (rebuild doesn't), they
// only need `planTasks` to have something to compile against.
const CORE_YAML = `id: repro-core
layers:
  - id: schema
    scope: [src/{module}/schema.ts]
    verify: node -e "process.exit(0)"
    commit: "feat({module}): schema"
  - id: service
    depends_on: schema
    scope: [src/{module}/service.ts]
    verify: node -e "process.exit(0)"
    commit: "feat({module}): service"
`;

function statements(prefix, count) {
  return Array.from({ length: count }, (_, i) => `${prefix} statement ${i + 1}`);
}

// Builds one intent in exactly the on-disk shape `addIntent` writes:
// normalizeIntent's OUTPUT — `requirements: [{id, kind, statement}]`, not
// the `rules`/`constraints`/`acceptance` input arrays. This is what a
// real, committed `.hedgehog/intents/<id>.json` looks like on a project
// whose intents were added through `hedgehog intent add`.
export function intentFixture({ id, dependsOn = [], rules, constraints, acceptance, priority = 100 }) {
  const requirements = [];
  const push = (kind, list) =>
    list.forEach((statement, index) => {
      requirements.push({
        id: `${id}-${kind}-${index + 1}`.toUpperCase(),
        kind,
        statement,
      });
    });
  push('rule', statements(`${id} rule`, rules));
  push('constraint', statements(`${id} constraint`, constraints));
  push('acceptance', statements(`${id} acceptance`, acceptance));

  return {
    id,
    goal: `goal for ${id}`,
    outcome: `outcome for ${id}`,
    priority,
    requirements,
    depends_on: dependsOn,
  };
}

// Four intents whose ALPHABETICAL filename order contradicts their
// DEPENDENCY order:
//
//   alphabetical: automation, board, card, list
//   dependency:   board -> list -> card -> automation
//
// `card` carries 22 requirements and `list` carries 10 — the two
// modules that lost exactly that many on the real project.
export const OUT_OF_ORDER_INTENTS = [
  intentFixture({ id: 'board', rules: 4, constraints: 1, acceptance: 1 }),
  intentFixture({ id: 'list', dependsOn: ['board'], rules: 6, constraints: 2, acceptance: 2 }),
  intentFixture({ id: 'card', dependsOn: ['list'], rules: 14, constraints: 4, acceptance: 4 }),
  intentFixture({ id: 'automation', dependsOn: ['card'], rules: 3, constraints: 1, acceptance: 1 }),
];

// Same intents, but named so that alphabetical order already AGREES with
// dependency order (a-board, b-list, c-card, d-automation). Isolates the
// normalize/write-order defect from the replay-order defect.
export const IN_ORDER_INTENTS = [
  intentFixture({ id: 'a-board', rules: 4, constraints: 1, acceptance: 1 }),
  intentFixture({ id: 'b-list', dependsOn: ['a-board'], rules: 6, constraints: 2, acceptance: 2 }),
  intentFixture({ id: 'c-card', dependsOn: ['b-list'], rules: 14, constraints: 4, acceptance: 4 }),
  intentFixture({ id: 'd-automation', dependsOn: ['c-card'], rules: 3, constraints: 1, acceptance: 1 }),
];

// A cycle, to prove the fixed replay reports it clearly instead of
// looping or dying on a FOREIGN KEY error.
export const CYCLIC_INTENTS = [
  intentFixture({ id: 'alpha', dependsOn: ['gamma'], rules: 2, constraints: 0, acceptance: 0 }),
  intentFixture({ id: 'beta', dependsOn: ['alpha'], rules: 2, constraints: 0, acceptance: 0 }),
  intentFixture({ id: 'gamma', dependsOn: ['beta'], rules: 2, constraints: 0, acceptance: 0 }),
];

// ---------------------------------------------------------------------
// temp project
// ---------------------------------------------------------------------

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Creates a throwaway git repo with `.hedgehog/core.yaml` and the given
// intents under `.hedgehog/intents/`, and chdirs into it. Returns the
// path. The intent files are written and committed BEFORE any rebuild
// runs, so git itself is a second witness to whether they changed.
export async function makeProject(intents, { commitSubjects = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hedgehog-repro-'));

  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'repro@example.invalid');
  git(root, 'config', 'user.name', 'repro');
  git(root, 'config', 'commit.gpgsign', 'false');

  await mkdir(join(root, '.hedgehog', 'intents'), { recursive: true });
  await writeFile(join(root, '.hedgehog', 'core.yaml'), CORE_YAML);
  for (const intent of intents) {
    await writeFile(
      join(root, '.hedgehog', 'intents', `${intent.id}.json`),
      JSON.stringify(intent, null, 2),
    );
  }
  await writeFile(join(root, '.gitignore'), '.hedgehog/hedgehog.db\n');

  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'chore: seed intents');

  // Optional extra commits whose subjects match compiled task
  // commit_messages, so markCompletedTasks has something to reconcile.
  for (const subject of commitSubjects) {
    git(root, 'commit', '--quiet', '--allow-empty', '-m', subject);
  }

  process.chdir(root);
  return root;
}

// ---------------------------------------------------------------------
// the byte-identical check
// ---------------------------------------------------------------------

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export async function snapshotIntents(root) {
  const dir = join(root, '.hedgehog', 'intents');
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const snapshot = new Map();
  for (const name of names) {
    const bytes = await readFile(join(dir, name));
    snapshot.set(name, { sha: sha256(bytes), size: bytes.length, bytes });
  }
  return snapshot;
}

// Reports the diff between two snapshots as a human-readable string, and
// counts requirements so a silent emptying is named as such rather than
// only as a hash mismatch.
export function diffSnapshots(before, after) {
  const problems = [];
  for (const [name, b] of before) {
    const a = after.get(name);
    if (!a) {
      problems.push(`${name}: DELETED`);
      continue;
    }
    if (a.sha === b.sha) continue;
    let detail = `sha ${b.sha.slice(0, 12)} -> ${a.sha.slice(0, 12)}, ${b.size}B -> ${a.size}B`;
    try {
      const bReq = JSON.parse(b.bytes.toString('utf8')).requirements?.length ?? '?';
      const aReq = JSON.parse(a.bytes.toString('utf8')).requirements?.length ?? '?';
      detail += `, requirements ${bReq} -> ${aReq}`;
      if (bReq > 0 && aReq === 0) detail += '  <-- PERMANENT RECORD EMPTIED';
    } catch {
      detail += ', (unparseable)';
    }
    problems.push(`${name}: ${detail}`);
  }
  for (const name of after.keys()) {
    if (!before.has(name)) problems.push(`${name}: UNEXPECTED NEW FILE`);
  }
  return problems;
}

export function reportSnapshot(label, snapshot) {
  console.log(`  ${label}`);
  for (const [name, entry] of snapshot) {
    const req = JSON.parse(entry.bytes.toString('utf8')).requirements?.length ?? '?';
    console.log(`    ${name.padEnd(22)} ${entry.sha.slice(0, 16)}  ${String(entry.size).padStart(6)}B  ${String(req).padStart(3)} requirements`);
  }
}
