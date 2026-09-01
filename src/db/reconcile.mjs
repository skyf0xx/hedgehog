// `hedgehog reconcile` — absorbs work that landed outside the loop into
// the build graph, on the user's word rather than on the engine's.
//
// `hedgehog claim` fingerprints the working tree at claim time and
// `verify` excludes every path that did not move during the lease
// (claim.mjs, verify.mjs#attributedToTask), so a hand edit is correctly
// never *blamed* on a task. It is also never *credited* to one.
// `hedgehog db rebuild` does not close that gap either: it recovers
// `tasks.status` by matching each task's `commit_message` against commit
// subjects exactly (rebuild.mjs#markCompletedTasks), and that subject is
// the one `verify` itself writes from core.yaml. A hand-written commit
// never matches, by construction. So `hedgehog next` and `hedgehog
// status` point at work that is already done, and the only remaining
// moves are to redo the work through the loop or to hand-patch a task row
// — which every loop skill forbids, because the graph is derived and
// gitignored and the patch dies at the next rebuild.
//
// Four properties, each load-bearing:
//
//   - **It proposes; it never asserts.** `gatherEvidence` reports which
//     commits since the newest graph-written commit touched files inside
//     an open task's compiled scope_globs. A diff cannot tell you a
//     task's intent was met, so nothing here closes a task on its own.
//   - **The user confirms one task at a time.** `confirmReconciliation`
//     takes exactly one task id and one reason. There is deliberately no
//     bulk confirm: a single "yes to all" is exactly the unexamined
//     assertion the evidence path refuses to make.
//   - **A confirmed task records why.** Closing a task from reconciliation
//     is not the fact `verify` records: no scope gate ran and no verify
//     command ran. That distinction is inherited context for everything
//     downstream, so `applyReconciliation` writes it as a `decisions` row
//     (decision.mjs) which next.mjs renders into every dependent task's
//     packet.
//   - **It survives a rebuild.** The confirmation is a committed file
//     under `.hedgehog/reconciled/`, in the same shape overrides.mjs uses
//     for the same reason: a decision with no other committed source has
//     to be replayable, or the next `db rebuild` silently reverts it and
//     reintroduces the problem. `rebuild.mjs` replays these alongside
//     `.hedgehog/overrides/*.json`.
//
// It never runs on its own. No `status`, `next`, or `claim` path calls
// into this file — reconciliation is a deliberate act, because it is the
// one way a task reaches `complete` without the engine having checked
// anything.

import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { applySchema } from './schema.mjs';

export const RECONCILED_DIR = '.hedgehog/reconciled';

// The note attached to a reconciled task, and the prefix every such note
// carries. next.mjs renders `decisions` rows into each dependent task's
// INHERITED DECISIONS section, so a dependent's packet says outright that
// its prerequisite closed unverified. The prefix is also how the replay
// and the status surface recognize their own rows without a second table.
export const RECONCILED_NOTE_PREFIX = 'Closed by reconciliation, not verification';

export function reconciledNote(record) {
  return (
    `${RECONCILED_NOTE_PREFIX}: ${record.reason} ` +
    `(no scope gate and no verify command ran; evidence: ${record.evidence.commits.length} commit(s), ` +
    `${record.evidence.paths.length} path(s) in scope)`
  );
}

function reconciledFilePath(taskId, reconciledDir = RECONCILED_DIR) {
  return `${reconciledDir}/${taskId.toLowerCase()}.json`;
}

// Runs git with an argv array and no shell, so a path or a glob reaches
// git as one literal argument — the same rule verify.mjs#git follows for
// the same reason.
function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options });
}

// Validates one parsed reconciliation record. Throws with the offending
// file's path, since this runs at load time over the whole directory and
// a bad record has to name itself to be findable — overrides.mjs's
// validateOverride, same contract.
function validateReconciled(record, path) {
  if (record === null || typeof record !== 'object') {
    throw new Error(`${path}: reconciliation must be a JSON object`);
  }
  let { task } = record;
  const { reason, confirmed_at: confirmedAt, evidence } = record;

  if (!task || typeof task !== 'string') {
    throw new Error(`${path}: reconciliation requires a "task" id (string)`);
  }
  // plan.mjs#taskId upper-cases every id it compiles a task under, and
  // the replay looks tasks up by that exact string. Normalizing here,
  // once, keeps the id space exact-match everywhere else — the same
  // reason overrides.mjs normalizes.
  task = task.toUpperCase();

  if (!reason || typeof reason !== 'string') {
    throw new Error(
      `${path}: reconciliation "${task}" requires a "reason" (string) — this is the permanent record of why a task closed without a verify run`,
    );
  }
  if (!confirmedAt || typeof confirmedAt !== 'string') {
    throw new Error(`${path}: reconciliation "${task}" requires a "confirmed_at" timestamp (string)`);
  }
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error(`${path}: reconciliation "${task}" requires an "evidence" object`);
  }
  for (const field of ['commits', 'paths']) {
    if (!Array.isArray(evidence[field])) {
      throw new Error(`${path}: reconciliation "${task}" requires "evidence.${field}" (array)`);
    }
    for (const entry of evidence[field]) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new Error(
          `${path}: reconciliation "${task}" has a non-string or empty entry in evidence.${field}`,
        );
      }
    }
  }

  return {
    task,
    reason,
    confirmed_at: confirmedAt,
    evidence: { commits: [...evidence.commits], paths: [...evidence.paths] },
  };
}

// Every *.json in `reconciledDir`, validated, as a Map from task id to
// its record. One file per task: a second confirmation of the same task
// is a mistake rather than a second distinct fact, unlike an override,
// where two separately-reasoned widenings of one task are both real.
// Absent directory reads as "nothing reconciled", the same way
// overrides.mjs#loadOverrides treats a missing overrides directory.
export async function loadReconciliations(reconciledDir = RECONCILED_DIR) {
  let entries;
  try {
    entries = await readdir(reconciledDir);
  } catch {
    return new Map();
  }

  const byTask = new Map();
  for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
    const path = `${reconciledDir}/${name}`;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      throw new Error(`could not read reconciliation file ${path}: ${err.message}`, { cause: err });
    }
    const record = validateReconciled(parsed, path);
    byTask.set(record.task, record);
  }
  return byTask;
}

// Reconciled task ids matching no row in `tasks` — a typo'd id, a task
// from a renamed module or layer, or one whose intent file is gone. The
// read side that keeps a dead record discoverable, exactly as
// overrides.mjs#orphanedOverrides does: the replay skipping an unknown id
// is a no-op, not a throw, so without this the file would sit there
// closing nothing forever.
export function orphanedReconciliations(db, reconciliations) {
  const known = new Set(db.prepare('SELECT id FROM tasks').all().map((r) => r.id));
  return [...reconciliations.keys()].filter((taskId) => !known.has(taskId)).sort();
}

// ── evidence ──────────────────────────────────────────────────────────

// The newest commit the graph itself wrote — the newest commit whose
// subject matches some task's `commit_message`, which is the exact
// predicate rebuild.mjs#markCompletedTasks uses to decide a task ran.
// Everything above it in history is the window this command reads: it is
// where hand-written work necessarily sits, because a graph-written
// commit below it has already been credited by rebuild.
//
// Returns null when no commit matches any task's message (nothing has
// been verified yet) — the caller then reads the whole history, which is
// the honest window for a project whose loop has not closed a task.
function newestGraphCommit(db) {
  const messages = new Set(
    db.prepare('SELECT commit_message FROM tasks').all().map((r) => r.commit_message),
  );
  if (messages.size === 0) return null;

  const output = git(['log', '--topo-order', '--format=%H%x00%s']);
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [sha, subject] = line.split('\0');
    if (subject !== undefined && messages.has(subject)) return sha;
  }
  return null;
}

// Every commit after `sinceSha` (exclusive), newest first, with the paths
// it touched. `sinceSha` null means the whole history.
function commitsSince(sinceSha) {
  const range = sinceSha ? [`${sinceSha}..HEAD`] : ['HEAD'];
  let output;
  try {
    output = git(['log', '--topo-order', '--name-only', '--format=%x01%H%x00%s', ...range]);
  } catch {
    // An empty repository has no HEAD to log.
    return [];
  }

  const commits = [];
  for (const block of output.split('\x01')) {
    if (!block.trim()) continue;
    const [header, ...rest] = block.split('\n');
    const [sha, subject] = header.split('\0');
    if (!sha) continue;
    const paths = rest.map((p) => p.trim()).filter(Boolean);
    commits.push({ sha, subject: subject ?? '', paths });
  }
  return commits;
}

// True when `path` matches `glob`.
//
// The scope globs compiled onto a task are git pathspec globs
// (`apps/api/src/orders/**`), and verify.mjs's gate hands them straight
// to git as `:(glob)…` pathspecs. Here the paths already came out of `git
// log --name-only`, so there is no second git call to make: the match is
// done in-process against the same syntax git implements — `**` spans
// separators, a single `*` and `?` do not, and a trailing `/**` also
// matches the directory's own path, which is what makes a glob and the
// directory it names agree.
//
// Segment-by-segment rather than character-by-character, so the two `**`
// forms (a whole segment, versus a `*` pair inside one) can't be confused
// for each other.
function globToRegExp(glob) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // A `*` or `?` inside one path segment never crosses a separator.
  const segmentPattern = (segment) =>
    segment
      .split(/(\*|\?)/)
      .map((part) => (part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escape(part)))
      .join('');

  const segments = glob.split('/');
  let out = '';
  for (const [i, segment] of segments.entries()) {
    if (segment === '**') {
      // `**` and the separator on one side of it are optional together,
      // so `a/**` also matches `a` and `**/x.ts` also matches `x.ts`.
      if (i === segments.length - 1) {
        // Trailing: the separator *before* it goes optional with it —
        // unless there is nothing before it, and the glob is the bare
        // `**` that matches everything.
        out += i === 0 ? '.*' : '(?:/.*)?';
      } else {
        // Interior or leading: the separator *after* it goes optional
        // with it. A preceding literal segment still needs its own
        // separator written first.
        if (i > 0) out += '/';
        out += '(?:.*/)?';
      }
      continue;
    }
    // Only a preceding literal segment contributes the separator — a
    // preceding `**` already carried its own.
    if (i > 0 && segments[i - 1] !== '**') out += '/';
    out += segmentPattern(segment);
  }

  return new RegExp(`^${out}$`);
}

export function pathInScope(path, scopeGlobs) {
  return scopeGlobs.some((glob) => globToRegExp(glob).test(path));
}

// Tasks a reconciliation could apply to: `planned` or `ready`, the two
// statuses `hedgehog next` would still hand out. A `building`/`verifying`
// task is leased and belongs to whoever holds it; a `blocked` task failed
// a gate the loop already ran and has `retry` as its way back; a
// `complete` task is done.
const OPEN_TASKS_SQL = `
  SELECT id, layer, module, objective, scope_globs, status
  FROM tasks
  WHERE status IN ('planned', 'ready')
  ORDER BY priority, id;
`;

// The read path. For every open task, which of the commits since the
// newest graph-written commit touched files inside that task's compiled
// scope_globs.
//
// Returns { since, commits, candidates, alreadyReconciled }:
//   - `since` the sha the window starts above, or null for whole history
//   - `commits` every commit in the window (so a caller can report a
//     window that contained nothing)
//   - `candidates` one entry per open task with at least one matching
//     path: { task, commits: [{sha, subject, paths}], paths }
//   - `alreadyReconciled` open task ids that already have a committed
//     confirmation on disk (their file exists but the graph has not been
//     rebuilt since)
//
// This is evidence, not proof. A commit touching a task's scope says
// files moved where that task would have moved them; it says nothing
// about whether the task's objective was met. Every caller must put the
// judgment to the user.
export function gatherEvidence(db, { reconciliations = new Map() } = {}) {
  const since = newestGraphCommit(db);
  const commits = commitsSince(since);
  const openTasks = db.prepare(OPEN_TASKS_SQL).all();

  const candidates = [];
  const alreadyReconciled = [];
  for (const task of openTasks) {
    if (reconciliations.has(task.id)) alreadyReconciled.push(task.id);

    const scopeGlobs = JSON.parse(task.scope_globs);
    const matched = [];
    const paths = new Set();
    for (const commit of commits) {
      const hits = commit.paths.filter((p) => pathInScope(p, scopeGlobs));
      if (hits.length === 0) continue;
      matched.push({ sha: commit.sha, subject: commit.subject, paths: hits });
      for (const p of hits) paths.add(p);
    }
    if (matched.length > 0) {
      candidates.push({ task, commits: matched, paths: [...paths].sort() });
    }
  }

  return { since, commits, candidates, alreadyReconciled };
}

// ── confirmation ──────────────────────────────────────────────────────

// Writes one reconciliation record to
// RECONCILED_DIR/<task-id-lowercased>.json via temp file + rename, so a
// crash mid-write can never leave a half-written file for
// loadReconciliations to trip on — overrides.mjs#writeOverrideFile and
// intent.mjs#writeIntentFile use the same pattern for the same reason.
//
// Refuses to overwrite silently. A task is reconciled once; a second
// confirmation for the same id is a wrong id or a forgotten first run,
// and either is worth stopping for.
export async function writeReconciledFile(record, reconciledDir = RECONCILED_DIR) {
  const path = reconciledFilePath(record.task, reconciledDir);
  try {
    await readFile(path, 'utf8');
    throw new Error(
      `${path} already exists — ${record.task} is already recorded as reconciled. Edit that file directly rather than re-confirming.`,
    );
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  await mkdir(reconciledDir, { recursive: true });
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

// Applies one confirmed reconciliation to the graph: the task goes
// `complete`, its provenance note is written as a `decisions` row, and
// its dependents are re-evaluated for readiness the same way verify.mjs
// does on a pass.
//
// Marking the status directly is correct here for the same reason
// rebuild.mjs#markCompletedTasks does it: there is no lease to check, no
// working-tree diff to gate, and no verify_command to run. The difference
// from verify is exactly what the note records.
export function applyReconciliation(db, record) {
  applySchema(db);

  const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(record.task);
  if (!task) throw new Error(`no such task: ${record.task}`);
  if (task.status === 'complete') return { taskId: record.task, unlocked: [], alreadyComplete: true };
  if (task.status === 'building' || task.status === 'verifying') {
    throw new Error(
      `Task ${record.task} is leased (${task.status}) — release it with \`hedgehog release ${record.task} --owner <owner>\` before reconciling it.`,
    );
  }

  let unlocked;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      "UPDATE tasks SET status = 'complete', blocked_reason = NULL WHERE id = ?",
    ).run(record.task);
    db.prepare('INSERT INTO decisions (task_id, note) VALUES (?, ?)').run(
      record.task,
      reconciledNote(record),
    );
    unlocked = unlockDependents(db, record.task);
    completeIntentIfDone(db, record.task);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback failing must not mask the original error.
    }
    throw err;
  }

  return { taskId: record.task, unlocked, alreadyComplete: false };
}

// Marks `taskId`'s direct dependents `ready` wherever every one of their
// dependencies is now complete — the same rule and the same restriction
// verify.mjs#unlockReadyDependents applies: a dependent already `blocked`
// is stalled on its own failure, not on this dependency, and must not be
// cleared back to ready here.
function unlockDependents(db, taskId) {
  const dependents = db
    .prepare(
      `SELECT t.id, t.status FROM tasks t
       JOIN dependencies d ON d.task_id = t.id
       WHERE d.depends_on_task_id = ?
       ORDER BY t.priority, t.id`,
    )
    .all(taskId);

  const unlocked = [];
  for (const dependent of dependents) {
    if (dependent.status !== 'planned') continue;
    const blocker = db
      .prepare(
        `SELECT 1 FROM dependencies d
         JOIN tasks dep ON dep.id = d.depends_on_task_id
         WHERE d.task_id = ? AND dep.status <> 'complete'`,
      )
      .get(dependent.id);
    if (blocker !== undefined) continue;
    db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(dependent.id);
    unlocked.push(dependent.id);
  }
  return unlocked;
}

// Closes the task's intent once every task compiled from it is complete
// — the same terminal bookkeeping verify.mjs#completeIntentIfDone does,
// so an intent whose last open task closes by reconciliation does not sit
// `active` forever.
function completeIntentIfDone(db, taskId) {
  const row = db.prepare('SELECT intent_id FROM tasks WHERE id = ?').get(taskId);
  if (!row) return;
  const openTask = db
    .prepare("SELECT 1 FROM tasks WHERE intent_id = ? AND status <> 'complete'")
    .get(row.intent_id);
  if (openTask !== undefined) return;
  db.prepare("UPDATE intents SET status = 'complete' WHERE id = ?").run(row.intent_id);
}

// The `hedgehog reconcile confirm <task-id> --reason "<why>"` entry
// point: builds the record from the task's own evidence, writes the
// committed file first, then applies it to the graph.
//
// File before graph, deliberately. The graph is derived and gitignored;
// the file is the permanent record. If the write fails, nothing has been
// closed on a fact that would not survive the next rebuild.
export async function confirmReconciliation(
  db,
  { taskId, reason, evidence },
  reconciledDir = RECONCILED_DIR,
) {
  if (!taskId) throw new Error('reconcile requires a task id');
  if (!reason) throw new Error('reconcile requires a --reason');

  const id = taskId.toUpperCase();
  const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(id);
  if (!task) throw new Error(`no such task: ${id}`);
  if (task.status === 'complete') {
    throw new Error(`Task ${id} is already complete — there is nothing to reconcile.`);
  }

  const record = validateReconciled(
    {
      task: id,
      reason,
      confirmed_at: new Date().toISOString(),
      evidence: {
        commits: evidence?.commits ?? [],
        paths: evidence?.paths ?? [],
      },
    },
    '(new reconciliation)',
  );

  await writeReconciledFile(record, reconciledDir);
  const applied = applyReconciliation(db, record);
  return { record, ...applied };
}

// Evidence for exactly one task, in the shape confirmReconciliation
// wants. Returns null when that task is not an open candidate — a caller
// confirming a task the evidence path never proposed still gets to
// record the confirmation, with an empty evidence set that says so.
export function evidenceForTask(db, taskId) {
  const { candidates } = gatherEvidence(db);
  const entry = candidates.find((c) => c.task.id === taskId.toUpperCase());
  if (!entry) return null;
  return {
    commits: entry.commits.map((c) => c.sha),
    paths: entry.paths,
  };
}

// ── rendering ─────────────────────────────────────────────────────────

// Renders a gatherEvidence() result as a proposal. Every line is written
// to read as a question the user answers, not as a finding the command
// acted on — the confirm command is printed per task, one at a time, and
// no "confirm all" form exists to print.
export function formatEvidence({ since, commits, candidates, alreadyReconciled }) {
  const lines = [];

  lines.push(
    since
      ? `Reading ${commits.length} commit(s) since ${since.slice(0, 8)} — the newest commit the build graph itself wrote.`
      : `Reading ${commits.length} commit(s) — no commit in this history was written by the build graph.`,
  );
  lines.push('');

  if (candidates.length === 0) {
    lines.push('No open task has files in its scope touched by those commits.');
    lines.push('');
    lines.push('Nothing to propose. No task was changed.');
    return lines.join('\n');
  }

  lines.push('PROPOSED — evidence only. None of these tasks has been changed.');
  lines.push('');
  for (const { task, commits: matched, paths } of candidates) {
    lines.push(`  ${task.id}   ${task.layer}   ${task.objective}`);
    for (const commit of matched) {
      lines.push(`    ${commit.sha.slice(0, 8)}  ${commit.subject}`);
    }
    for (const path of paths) {
      lines.push(`      in scope: ${path}`);
    }
    lines.push('');
  }

  lines.push('A commit touching a task\'s scope is not proof the task\'s objective was met.');
  lines.push('Read the work, then confirm each task you judge done, one at a time:');
  lines.push('');
  lines.push('  hedgehog reconcile confirm <task-id> --reason "<why this work satisfies it>"');
  lines.push('');
  lines.push('Confirming closes the task without a scope gate or a verify run, and records');
  lines.push(`that in ${RECONCILED_DIR}/<task-id>.json — commit that file, or the next`);
  lines.push('`hedgehog db rebuild` reverts the reconciliation.');

  if (alreadyReconciled.length > 0) {
    lines.push('');
    lines.push('ALREADY CONFIRMED (still open in this graph — run `hedgehog db rebuild`)');
    for (const taskId of alreadyReconciled) lines.push(`  ${taskId}`);
  }

  return lines.join('\n');
}

// Renders loadReconciliations() as a listing — `hedgehog reconcile list`.
export function formatReconciliations(reconciliations, orphaned = []) {
  if (reconciliations.size === 0) return 'No reconciliations recorded.';

  const lines = [];
  for (const [taskId, record] of reconciliations) {
    lines.push(taskId);
    lines.push(`  ${record.reason}`);
    lines.push(`  confirmed ${record.confirmed_at}`);
    for (const sha of record.evidence.commits) lines.push(`  commit ${sha.slice(0, 8)}`);
    for (const path of record.evidence.paths) lines.push(`  path   ${path}`);
    lines.push('');
  }

  if (orphaned.length > 0) {
    lines.push(
      `Orphaned: ${orphaned.join(', ')} — no task with this id exists in the build graph. ` +
        `Each closes nothing until the id matches.`,
    );
  }

  return lines.join('\n').trimEnd();
}
