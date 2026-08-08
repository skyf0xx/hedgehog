// Shared harness for the recovery-command reproductions.
//
// Each repro builds a throwaway Hedgehog project in its own temp
// directory — a real git repo, a real authored core.yaml, a real build
// graph — drives a task into one of the situations the CLI had no
// command for, and asserts the new command resolves it. No test
// framework and no sqlite3 binary are involved: assertions are plain
// throws, state is read back through node:sqlite, and a failing repro
// exits non-zero.
//
// Setup writes intents and compiles the graph by importing src/db
// directly rather than shelling out to `hedgehog plan`, because plan
// spawns a graph server and opens a browser on success — neither of
// which belongs in a repro run.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(__dirname, '..');
export const CLI = join(PKG_ROOT, 'bin/cli.mjs');

export class AssertionError extends Error {}

export function assert(condition, message) {
  if (!condition) throw new AssertionError(message);
}

export function assertIncludes(haystack, needle, message) {
  assert(
    haystack.includes(needle),
    `${message}\n  expected output to contain: ${JSON.stringify(needle)}\n  actual output:\n${indent(haystack)}`,
  );
}

export function assertExcludes(haystack, needle, message) {
  assert(
    !haystack.includes(needle),
    `${message}\n  expected output NOT to contain: ${JSON.stringify(needle)}\n  actual output:\n${indent(haystack)}`,
  );
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => `    | ${line}`)
    .join('\n');
}

// The default core: a two-layer chain on a module axis. `verify.mjs`
// (written into the project below) fails whenever a `FAIL` sentinel file
// exists, which is how a repro drives a verification failure on demand.
export const DEFAULT_CORE = `id: repro-core
layers:
  - id: schema
    scope: [src/{module}/schema.txt]
    verify: node verify.mjs
    commit: "feat({module}): schema"
  - id: service
    depends_on: schema
    scope: [src/{module}/service.txt]
    verify: node verify.mjs
    commit: "feat({module}): service"
`;

// A core whose second layer is `exclusive: true` and sorts *after* the
// per-module layer by task id — the starvation shape: the fan-out walks
// candidates in (priority, id) order and takes the first non-conflicting
// set, so an exclusive task with any non-exclusive candidate ahead of it
// is never handed out, however many times claim runs.
export const EXCLUSIVE_CORE = `id: repro-core
layers:
  - id: schema
    scope: [src/{module}/schema.txt]
    verify: node verify.mjs
    commit: "feat({module}): schema"
  - id: zintegrate
    exclusive: true
    scope: [src/integration.txt]
    verify: node verify.mjs
    commit: "feat({module}): integrate"
`;

const VERIFY_SCRIPT = `import { existsSync } from 'node:fs';
// Exit 1 while the FAIL sentinel exists — the repro's switch for driving
// a verification failure, and its switch for driving a pass afterward.
process.exit(existsSync('FAIL') ? 1 : 0);
`;

const GITIGNORE = `.hedgehog/hedgehog.db
.hedgehog/hedgehog.db-*
.hedgehog/commit.lock
.hedgehog/graph-server.json
FAIL
`;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

// Creates a throwaway project: git repo, core.yaml, verify script, seed
// commit, build graph with `intents` compiled through `core`. Returns the
// project directory (absolute) and a cleanup function.
export async function makeProject({ core = DEFAULT_CORE, intents = ['alpha'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hedgehog-repro-'));

  await mkdir(join(dir, '.hedgehog'), { recursive: true });
  await writeFile(join(dir, '.hedgehog/core.yaml'), core);
  await writeFile(join(dir, 'verify.mjs'), VERIFY_SCRIPT);
  await writeFile(join(dir, '.gitignore'), GITIGNORE);

  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'repro@example.com']);
  git(dir, ['config', 'user.name', 'Hedgehog Repro']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'chore: seed']);

  // The build graph is compiled in-process, from the project directory —
  // DB_PATH and INTENTS_DIR are both relative, so cwd is what decides
  // which project they land in.
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    const { dbInit, openDb, DB_PATH } = await import('../src/db/init.mjs');
    const { addIntent } = await import('../src/db/intent.mjs');
    const { planTasks } = await import('../src/db/plan.mjs');
    const { loadCore } = await import('../src/db/core.mjs');

    await dbInit(DB_PATH);
    const db = openDb();
    try {
      for (const id of intents) {
        await addIntent(db, {
          id,
          goal: `build ${id}`,
          outcome: `${id} works`,
          rules: [`${id} must be correct`],
        });
      }
      planTasks(db, await loadCore(join(dir, '.hedgehog/core.yaml')));
    } finally {
      db.close();
    }
  } finally {
    process.chdir(previousCwd);
  }

  // Intents are committed state in a real project (planner commits
  // them); leaving them untracked would make every later verify see them
  // as touched-outside-scope.
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'chore: intents']);

  return {
    dir,
    dbPath: join(dir, '.hedgehog/hedgehog.db'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// Runs the CLI in `cwd`, capturing exit code and combined output rather
// than throwing on a non-zero exit — a refusing command is an expected
// outcome here, not an exception.
export function hedgehog(cwd, args) {
  const result = execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    // ExperimentalWarning: SQLite noise on stderr would otherwise land in
    // every captured output string.
    env: { ...process.env, NODE_NO_WARNINGS: '1', NO_COLOR: '1' },
    // execFileSync throws on non-zero; catching below keeps the code.
  });
  return { code: 0, out: result };
}

export function hedgehogAllowFail(cwd, args) {
  try {
    return hedgehog(cwd, args);
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  }
}

// Reads one task row straight out of the build graph, by absolute path —
// the check that the CLI actually moved the state it claimed to move.
export function readTask(dbPath, taskId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  } finally {
    db.close();
  }
}

// Runs `body` with a fresh project, reports pass/fail, and exits
// non-zero on failure so a runner (or CI) can gate on it.
export async function runRepro(name, body) {
  try {
    await body();
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(`  ${err.message}`);
    if (!(err instanceof AssertionError) && err.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}
