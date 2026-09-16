// `hedgehog fast-path <intent-id> --reason "<why>"` — a sanctioned way to
// close every remaining task of an intent below the normal claim/verify
// ceremony, for a change small enough that walking it through every
// remaining layer costs more than the risk the loop exists to catch.
//
// This is not a second way to skip verification. It is a narrower,
// explicit substitute for it:
//
//   - The working tree must be clean (everything already committed) —
//     fast-pathing an intent whose fix is still sitting uncommitted has
//     nothing for the scope check below to check.
//   - The union of every remaining task's own scope_globs still gates the
//     diff, exactly the way `hedgehog verify`'s own scope gate does: a
//     commit that touched anything outside that union blocks the
//     fast-path the same way it would block a normal verify. Discretion
//     over ceremony never extends to discretion over the one guarantee
//     that matters — a layer only writes inside its own boundary.
//   - `--verify` names one real command that must pass before anything
//     completes; the caller states it explicitly (the union of the
//     skipped layers' own verify_commands is the honest default, but a
//     narrower substitute is allowed, per that call being the same kind
//     of judgment call `hedgehog verify` doesn't need a human for).
//   - The decision is a committed record under `.hedgehog/fastpath/`, the
//     same file-before-row shape reconcile.mjs uses, and for the same
//     reason: without it, `hedgehog db rebuild` has nothing to replay and
//     silently reintroduces every task this closed.
//
// A fast-pathed task is functionally identical to a reconciled one from
// markCompletedTasks's point of view — no commit_message of its own to
// match, closed by a committed decision instead — so rebuild.mjs seeds it
// into the same `reconciledTaskIds`-shaped set reconciliation uses.

import { execFileSync, execSync } from 'node:child_process';
import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { pathInScope, newestGraphCommit, commitsSince } from './reconcile.mjs';
import { isEngineStatePath } from './engineState.mjs';

export const FASTPATH_DIR = '.hedgehog/fastpath';

function fastpathFilePath(intentId, fastpathDir = FASTPATH_DIR) {
  return `${fastpathDir}/${intentId.toLowerCase()}.json`;
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options });
}

function validateFastpath(record, path) {
  if (record === null || typeof record !== 'object') {
    throw new Error(`${path}: fast-path record must be a JSON object`);
  }
  const { intent, reason, verify_command: verifyCommand, confirmed_at: confirmedAt, tasks } = record;

  // Not upper-cased: an intent id, unlike a task id, is stored exactly as
  // given at `intent add` time (intent.mjs#normalizeIntent never cases
  // it) — casing this would make the record's own lookup key disagree
  // with `intents.id`.
  if (!intent || typeof intent !== 'string') {
    throw new Error(`${path}: fast-path record requires an "intent" id (string)`);
  }

  if (!reason || typeof reason !== 'string') {
    throw new Error(`${path}: fast-path "${intent}" requires a "reason" (string)`);
  }
  if (!verifyCommand || typeof verifyCommand !== 'string') {
    throw new Error(`${path}: fast-path "${intent}" requires a "verify_command" (string)`);
  }
  if (!confirmedAt || typeof confirmedAt !== 'string') {
    throw new Error(`${path}: fast-path "${intent}" requires a "confirmed_at" timestamp (string)`);
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`${path}: fast-path "${intent}" requires a non-empty "tasks" array`);
  }
  for (const t of tasks) {
    if (typeof t !== 'string' || t.trim() === '') {
      throw new Error(`${path}: fast-path "${intent}" has a non-string or empty entry in tasks`);
    }
  }

  return {
    intent,
    reason,
    verify_command: verifyCommand,
    confirmed_at: confirmedAt,
    tasks: tasks.map((t) => t.toUpperCase()),
  };
}

// Every *.json in `fastpathDir`, validated, as a Map from intent id to its
// record — same convention as reconcile.mjs#loadReconciliations.
export async function loadFastpaths(fastpathDir = FASTPATH_DIR) {
  let entries;
  try {
    entries = await readdir(fastpathDir);
  } catch {
    return new Map();
  }

  const byIntent = new Map();
  for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
    const path = `${fastpathDir}/${name}`;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      throw new Error(`could not read fast-path record ${path}: ${err.message}`, { cause: err });
    }
    const record = validateFastpath(parsed, path);
    byIntent.set(record.intent, record);
  }
  return byIntent;
}

// Fast-pathed task ids matching no row in `tasks` — same read-side hygiene
// as reconcile.mjs#orphanedReconciliations.
export function orphanedFastpathTasks(db, fastpaths) {
  const known = new Set(db.prepare('SELECT id FROM tasks').all().map((r) => r.id));
  const orphaned = [];
  for (const record of fastpaths.values()) {
    for (const taskId of record.tasks) {
      if (!known.has(taskId)) orphaned.push(taskId);
    }
  }
  return orphaned.sort();
}

export async function writeFastpathFile(record, fastpathDir = FASTPATH_DIR) {
  const path = fastpathFilePath(record.intent, fastpathDir);
  try {
    await readFile(path, 'utf8');
    throw new Error(`${path} already exists — ${record.intent} is already recorded as fast-pathed.`);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  await mkdir(fastpathDir, { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`);
    await rename(tempPath, path);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  return record;
}

// Every task belonging to `intentId` that isn't already `complete` —
// exactly the set a fast-path is closing.
function loadRemainingTasks(db, intentId) {
  return db
    .prepare("SELECT id, scope_globs, verify_command FROM tasks WHERE intent_id = ? AND status <> 'complete'")
    .all(intentId);
}

// The provenance note fast-pathing writes into `decisions`, rendered into
// every dependent task's packet the same way reconcile.mjs#reconciledNote
// is — a dependent must be told outright that its prerequisite closed by
// explicit fast-path, not by a normal verify run.
export function fastpathNote(record) {
  return (
    `Closed by fast-path, not per-layer verification: ${record.reason} ` +
    `(verified with: ${record.verify_command}; ${record.tasks.length} task(s) closed together)`
  );
}

// Runs `hedgehog fast-path <intent-id> --reason "<why>"`.
//
// Refuses when the working tree is dirty — a fast-pathed intent's fix must
// already be committed, or there is nothing for the scope check below to
// check against. Refuses when any commit since the graph's own newest
// credited commit touched a path outside the union of the remaining
// tasks' own scope_globs — a fast-path is not a way around the one
// guarantee `hedgehog verify` exists to hold. Runs `verifyCommand` for
// real and refuses on a nonzero exit, exactly like `hedgehog verify`
// refuses to complete a task whose verify_command fails.
export async function runFastpath(
  db,
  { intentId, reason, verifyCommand },
  fastpathDir = FASTPATH_DIR,
) {
  if (!intentId) throw new Error('fast-path requires an intent id');
  if (!reason) throw new Error('fast-path requires a --reason');
  if (!verifyCommand) throw new Error('fast-path requires a --verify command');

  // Unlike a task id (always upper-cased — plan.mjs#taskId), an intent id
  // is stored exactly as given at `intent add` time (intent.mjs#normalizeIntent
  // never cases it), so it is looked up verbatim here too.
  const id = intentId;
  const intent = db.prepare('SELECT id FROM intents WHERE id = ?').get(id);
  if (!intent) throw new Error(`no such intent: ${id}`);

  const remaining = loadRemainingTasks(db, id);
  if (remaining.length === 0) {
    throw new Error(`Intent ${id} has no remaining tasks — there is nothing to fast-path.`);
  }

  const dirty = git(['status', '--porcelain']).trim();
  if (dirty !== '') {
    throw new Error(
      `The working tree has uncommitted changes. Fast-pathing requires the fix to already be ` +
        `committed, so the scope check below has something real to check:\n\n${dirty}`,
    );
  }

  const scopeGlobs = remaining.flatMap((t) => JSON.parse(t.scope_globs));
  const since = newestGraphCommit(db);
  const commits = commitsSince(since);
  // Excludes the same build-graph/engine state every scope-facing check
  // in this engine excludes (engineState.mjs) — the bootstrap commit that
  // first added core.yaml, .gitignore, or a committed intent file sits
  // inside this window on a project with nothing verified yet
  // (newestGraphCommit returns null there), and none of that is this
  // fast-path's own fix to be judged against.
  const offending = [];
  for (const commit of commits) {
    for (const path of commit.paths) {
      if (isEngineStatePath(path)) continue;
      if (!pathInScope(path, scopeGlobs)) offending.push(path);
    }
  }
  if (offending.length > 0) {
    throw new Error(
      `Scope violation. The following path(s) touched since the graph's last credited commit ` +
        `fall outside the union of ${id}'s remaining tasks' scope:\n\n` +
        [...new Set(offending)].map((p) => `  ${p}`).join('\n') +
        `\n\nA fast-path cannot close tasks whose scope wasn't actually where the change landed.`,
    );
  }

  let exitCode = 0;
  let output;
  try {
    output = execSync(verifyCommand, { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    exitCode = err.status ?? 1;
    output = `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message;
  }
  if (exitCode !== 0) {
    throw new Error(`Fast-path verification failed (exit ${exitCode}):\n\n${output}`);
  }

  const record = validateFastpath(
    {
      intent: id,
      reason,
      verify_command: verifyCommand,
      confirmed_at: new Date().toISOString(),
      tasks: remaining.map((t) => t.id),
    },
    '(new fast-path)',
  );

  await writeFastpathFile(record, fastpathDir);
  applyFastpath(db, record);
  return { record, output };
}

// Applies a confirmed fast-path record to the graph: every task it names
// goes `complete`, a provenance note lands on each, and the intent closes
// once nothing remains — the same bookkeeping reconcile.mjs#applyReconciliation
// does for a single task, run here over the whole set at once.
export function applyFastpath(db, record) {
  const note = fastpathNote(record);
  db.exec('BEGIN IMMEDIATE');
  try {
    const setComplete = db.prepare(
      "UPDATE tasks SET status = 'complete', blocked_reason = NULL WHERE id = ?",
    );
    const insertNote = db.prepare('INSERT INTO decisions (task_id, note) VALUES (?, ?)');
    for (const taskId of record.tasks) {
      setComplete.run(taskId);
      insertNote.run(taskId, note);
    }
    db.prepare(
      "UPDATE intents SET status = 'complete' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM tasks WHERE intent_id = ? AND status <> 'complete')",
    ).run(record.intent, record.intent);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback failing must not mask the original error.
    }
    throw err;
  }
}
