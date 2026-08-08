// Shared harness for the scope-gate reproductions.
//
// Every repro builds a throwaway git repo in a temp dir, seeds
// `.hedgehog/hedgehog.db` directly (no `plan`, no core.yaml — the gate
// under test only reads `tasks`), and drives the REAL CLI
// (`bin/cli.mjs verify`) as a subprocess with cwd set to that repo.
//
// No test framework and no `sqlite3` binary: assertions are plain
// throws, and the DB is written through `node:sqlite` (Node 22 needs
// --experimental-sqlite, which runScript passes through).

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { applySchema } from '../src/db/schema.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const CLI = join(REPO_ROOT, 'bin', 'cli.mjs');

// Prefix is deliberately specific to this fix so concurrent work in
// sibling clones never collides, and so cleanup can never glob wider
// than this one repro suite's own directories.
const TMP_PREFIX = 'hedgehog-scopegate-';

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A repo with two "layers" already committed, so a task can modify a
// tracked file inside its scope and another tracked file can be dirtied
// outside it.
export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'repro@example.test');
  git(dir, 'config', 'user.name', 'scope gate repro');
  git(dir, 'config', 'commit.gpgsign', 'false');

  mkdirSync(join(dir, '.hedgehog'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '.hedgehog/hedgehog.db*\n.hedgehog/commit.lock\n');

  mkdirSync(join(dir, 'pkg-a', 'src'), { recursive: true });
  mkdirSync(join(dir, 'pkg-b', 'src'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'pkg-a/src/index.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'pkg-b/src/index.js'), 'export const b = 1;\n');
  writeFileSync(join(dir, 'docs/notes.md'), 'baseline\n');
  writeFileSync(join(dir, 'shared.json'), '{"seams":0}\n');

  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'chore: baseline');

  const db = new DatabaseSync(join(dir, '.hedgehog', 'hedgehog.db'));
  db.exec('PRAGMA foreign_keys = ON');
  applySchema(db);
  db.exec(
    `INSERT INTO intents (id, goal, outcome, status) VALUES ('i1', 'repro', 'repro', 'planned')`,
  );
  db.close();

  return dir;
}

export function cleanup(dir) {
  // Never a glob — only the exact directory this process created.
  if (dir && dir.includes(TMP_PREFIX)) rmSync(dir, { recursive: true, force: true });
}

// Inserts one task straight into the graph, `planned` by default so the
// repros go on to lease it through the real `hedgehog claim` — the claim
// is half of the behaviour under test. Pass `status: 'building'` + an
// `owner` to hand-lease a task instead (used to model a lease taken
// before this fix existed, which carries no snapshot).
export function seedTask(
  dir,
  {
    id,
    scope,
    verifyCommand = 'true',
    commitMessage = `feat(${id}): layer`,
    status = 'planned',
    owner = 'repro',
    leaseMinutes = 45,
  },
) {
  const db = new DatabaseSync(join(dir, '.hedgehog', 'hedgehog.db'));
  db.exec('PRAGMA foreign_keys = ON');
  const leased = status === 'building' || status === 'verifying';
  db.prepare(
    `INSERT INTO tasks (id, intent_id, module, layer, objective, scope_globs,
                        verify_command, commit_message, status, lease_owner,
                        leased_at, lease_expires_at)
     VALUES (?, 'i1', ?, ?, ?, ?, ?, ?, ?, ?,
             CASE WHEN ? THEN datetime('now') END,
             CASE WHEN ? THEN datetime('now', '+' || ? || ' minutes') END)`,
  ).run(
    id,
    id,
    id,
    `build ${id}`,
    JSON.stringify(scope),
    verifyCommand,
    commitMessage,
    status,
    leased ? owner : null,
    leased ? 1 : 0,
    leased ? 1 : 0,
    leaseMinutes,
  );
  db.close();
}

export function taskRow(dir, id) {
  const db = new DatabaseSync(join(dir, '.hedgehog', 'hedgehog.db'), { readOnly: true });
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  db.close();
  return row;
}

function runCli(dir, args) {
  const res = spawnSync(process.execPath, ['--experimental-sqlite', CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    out: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  };
}

export function runVerify(dir, taskId, owner = 'repro') {
  return runCli(dir, ['verify', taskId, '--owner', owner]);
}

export function runClaim(dir, { owner = 'repro', count = 1 } = {}) {
  return runCli(dir, ['claim', '--owner', owner, '--count', String(count)]);
}

// Claims, and fails loudly rather than letting a later assertion report a
// confusing "not leased" error from verify.
export function claimOrThrow(dir, opts) {
  const res = runClaim(dir, opts);
  if (res.code !== 0) throw new Error(`hedgehog claim failed (exit ${res.code}):\n${res.out}`);
  return res;
}

export function write(dir, relPath, contents) {
  mkdirSync(dirname(join(dir, relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), contents);
}

export function append(dir, relPath, contents) {
  appendFileSync(join(dir, relPath), contents);
}

export function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

export function headFiles(dir) {
  return git(dir, 'show', '--name-only', '--pretty=format:', 'HEAD')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

export function headSubject(dir) {
  return git(dir, 'log', '-1', '--pretty=format:%s').trim();
}

// ── assertions ────────────────────────────────────────────────────────
const failures = [];

export function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}`);
  if (!ok) {
    console.log(`         expected: ${JSON.stringify(expected)}`);
    console.log(`         actual:   ${JSON.stringify(actual)}`);
    failures.push(label);
  }
  return ok;
}

export function finish(name) {
  if (failures.length > 0) {
    console.log(`\n${name}: ${failures.length} assertion(s) failed\n`);
    process.exit(1);
  }
  console.log(`\n${name}: ok\n`);
}
