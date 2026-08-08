// `hedgehog boundary` — is this a good moment to throw away the
// conversation?
//
// The discipline tells an operator to clear context at a natural
// boundary (CLAUDE.md, "Managing context"). `hedgehog quiesce` answers
// only whether anything is in flight — necessary, but not sufficient: a
// settled graph with half an intent built and a dirty working tree is
// exactly the moment clearing costs something. This command answers the
// whole question, from state the engine already holds, so the decision
// stops living in the operator's head.
//
// Three conditions, all derived, none remembered:
//
//   1. nothing in flight   — no task `building` or `verifying`
//                            (status.mjs's inFlight; the same set
//                            `quiesce` reports).
//   2. working tree clean  — `git status --porcelain` empty, minus the
//                            engine's own derived files (the gitignored
//                            build graph, its sqlite sidecars, the commit
//                            lock, the graph-server pidfile), which are
//                            never a reason to keep a conversation.
//   3. intent closed       — the last closed task completed its intent.
//                            verify.mjs's completeIntentIfDone already
//                            detects this and the CLI prints "intent
//                            complete" — this recomputes it from the same
//                            predicate rather than depending on anyone
//                            having read that line.
//
// Condition 3's "last closed task" is read from the `verifications`
// table (the newest `passed` row — the engine's own record of which task
// closed last), and falls back to git history when there is no such row:
// `hedgehog db rebuild` reconstructs `tasks.status` from commit subjects
// without replaying verifications, so a rebuilt graph has complete tasks
// and an empty verifications table. The fallback matches commit subjects
// against `tasks.commit_message`, which is exactly what verify.mjs
// committed and what rebuild.mjs already matches on.

import { execSync } from 'node:child_process';
import { DB_PATH } from './init.mjs';
import { LOCK_PATH } from './commitLock.mjs';
import { graphStatus } from './status.mjs';
import { nextTask, stalledTasks } from './next.mjs';

const GRAPH_PIDFILE_PATH = '.hedgehog/graph-server.json';

// Engine state, written by this CLI and nobody else, and derived from
// sources that are themselves committed — the same exclusion verify.mjs
// applies to its scope diff, for the same reason: the engine's own
// bookkeeping must never read as the operator's unfinished work. Covers
// SQLite's journal/WAL/SHM sidecars.
function isEngineStatePath(path) {
  return (
    path === DB_PATH ||
    path.startsWith(`${DB_PATH}-`) ||
    path === LOCK_PATH ||
    path === GRAPH_PIDFILE_PATH
  );
}

// One porcelain line is `XY <path>`, or `XY <old> -> <new>` for a rename
// — the path starts at column 3 in either case. Renames report the
// destination, the path that actually differs from HEAD.
function parsePorcelainLine(line) {
  const path = line.slice(3);
  const arrow = path.lastIndexOf(' -> ');
  return arrow === -1 ? path : path.slice(arrow + 4);
}

// The working tree's uncommitted paths (modified, staged, untracked),
// minus engine state. Returns { ok: false, error } instead of throwing
// when git itself can't answer — no repository, no git on PATH — since
// "the tree is dirty" and "there is no tree" are different answers and
// the caller reports them differently.
export function workingTreeState() {
  let output;
  try {
    output = execSync('git status --porcelain', { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    const detail = `${err.stderr ?? ''}`.trim() || err.message;
    return { ok: false, error: detail, dirty: [] };
  }
  const dirty = output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parsePorcelainLine)
    .filter((path) => !isEngineStatePath(path));
  return { ok: true, error: null, dirty };
}

// The task the engine most recently closed, and how that was determined:
//   'verification' — the newest passed `verifications` row (authoritative;
//                    the engine wrote it at the instant the task closed).
//   'commit'       — no verifications row exists (a rebuilt graph), so the
//                    newest commit subject matching a complete task's
//                    commit_message stands in.
// Returns null when nothing has completed yet, and
// { task: null, reason } when complete tasks exist but none can be
// identified as the last one — an honest "can't tell", not a verdict.
export function lastClosedTask(db) {
  const verified = db
    .prepare(
      `
      SELECT t.*, v.ran_at AS closed_at
      FROM verifications v
      JOIN tasks t ON t.id = v.task_id
      WHERE v.status = 'passed'
      ORDER BY v.id DESC
      LIMIT 1
    `,
    )
    .get();
  if (verified !== undefined) {
    return { task: verified, source: 'verification', reason: null };
  }

  const complete = db
    .prepare("SELECT * FROM tasks WHERE status = 'complete'")
    .all();
  if (complete.length === 0) return null;

  let subjects;
  try {
    subjects = execSync('git log --format=%s -n 200', { encoding: 'utf8', stdio: 'pipe' })
      .split('\n')
      .filter((line) => line !== '');
  } catch (err) {
    return {
      task: null,
      source: 'commit',
      reason: `no verification records, and git history is unreadable (${
        `${err.stderr ?? ''}`.trim() || err.message
      })`,
    };
  }

  const byMessage = new Map();
  for (const task of complete) {
    const bucket = byMessage.get(task.commit_message) ?? [];
    bucket.push(task);
    byMessage.set(task.commit_message, bucket);
  }

  for (const subject of subjects) {
    const matches = byMessage.get(subject);
    if (matches === undefined) continue;
    if (matches.length > 1) {
      return {
        task: null,
        source: 'commit',
        reason: `no verification records, and commit subject "${subject}" matches ${matches.length} complete tasks (${matches
          .map((t) => t.id)
          .join(', ')}) — which one closed last is not derivable`,
      };
    }
    return { task: matches[0], source: 'commit', reason: null };
  }

  return {
    task: null,
    source: 'commit',
    reason: `no verification records, and no commit in the last 200 subjects matches a complete task's commit_message`,
  };
}

// The tasks of `intentId` that are not yet complete — the same predicate
// verify.mjs's completeIntentIfDone uses to decide whether an intent has
// closed, read here instead of written.
function remainingIntentTasks(db, intentId) {
  return db
    .prepare(
      "SELECT id, layer FROM tasks WHERE intent_id = ? AND status <> 'complete' ORDER BY priority, id",
    )
    .all(intentId);
}

function loadIntent(db, intentId) {
  return db.prepare('SELECT * FROM intents WHERE id = ?').get(intentId);
}

function headCommit() {
  try {
    return execSync('git log -1 --format="%h %s"', { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

// Evaluates all three conditions and assembles everything the CLI needs
// to report them, position a fresh session, or both. Reads only — no
// lease is taken, no status is changed.
//
// `undecidable` is separate from `reached`: a condition that can't be
// evaluated (no git repository, an unidentifiable last closed task) is
// not the same answer as a condition that evaluated false, and the exit
// code distinguishes them.
export function boundaryState(db) {
  const graph = graphStatus(db);
  const tree = workingTreeState();
  const closed = lastClosedTask(db);

  const conditions = [];

  conditions.push({
    id: 'nothing-in-flight',
    label: 'nothing in flight',
    ok: graph.inFlight.length === 0,
    undecidable: false,
    detail:
      graph.inFlight.length === 0
        ? 'no task building or verifying'
        : `${graph.inFlight.length} task(s) in flight: ${graph.inFlight
            .map((t) => `${t.id} (${t.status}, owner: ${t.lease_owner})`)
            .join(', ')}`,
  });

  conditions.push({
    id: 'clean-tree',
    label: 'working tree clean',
    ok: tree.ok && tree.dirty.length === 0,
    undecidable: !tree.ok,
    detail: !tree.ok
      ? `working tree state is unreadable: ${tree.error}`
      : tree.dirty.length === 0
        ? 'no uncommitted changes'
        : `${tree.dirty.length} uncommitted path(s): ${tree.dirty.slice(0, 10).join(', ')}${
            tree.dirty.length > 10 ? `, +${tree.dirty.length - 10} more` : ''
          }`,
  });

  let intent = null;
  let remaining = [];
  if (closed === null) {
    conditions.push({
      id: 'intent-closed',
      label: 'last closed task completed an intent',
      ok: false,
      undecidable: false,
      detail: 'no task has completed yet — the build has no closed intent to sit behind',
    });
  } else if (closed.task === null) {
    conditions.push({
      id: 'intent-closed',
      label: 'last closed task completed an intent',
      ok: false,
      undecidable: true,
      detail: closed.reason,
    });
  } else {
    intent = loadIntent(db, closed.task.intent_id);
    remaining = remainingIntentTasks(db, closed.task.intent_id);
    conditions.push({
      id: 'intent-closed',
      label: 'last closed task completed an intent',
      ok: remaining.length === 0,
      undecidable: false,
      detail:
        remaining.length === 0
          ? `last closed task ${closed.task.id} completed intent "${closed.task.intent_id}"`
          : `last closed task ${closed.task.id} left intent "${closed.task.intent_id}" open — ${
              remaining.length
            } task(s) remain: ${remaining.map((t) => t.id).join(', ')}`,
    });
  }

  const undecidable = conditions.some((c) => c.undecidable);
  const reached = !undecidable && conditions.every((c) => c.ok);

  return {
    conditions,
    reached,
    undecidable,
    failed: conditions.filter((c) => !c.ok),
    graph,
    lastClosed: closed,
    intent,
    remaining,
    next: nextTask(db),
    stalled: stalledTasks(db),
    head: headCommit(),
  };
}

const MARK = { ok: '✓', no: '✗', unknown: '?' };

function mark(condition) {
  if (condition.undecidable) return MARK.unknown;
  return condition.ok ? MARK.ok : MARK.no;
}

// The human verdict: whether this is a boundary, and every condition with
// its own result — so a non-zero exit always names which condition
// failed, rather than leaving the operator to guess between three.
export function formatBoundary(state) {
  const lines = [];
  lines.push(
    state.undecidable
      ? 'Boundary undecidable.'
      : state.reached
        ? 'Boundary reached.'
        : 'Not a boundary.',
  );
  for (const condition of state.conditions) {
    lines.push(`  ${mark(condition)} ${condition.label} — ${condition.detail}`);
  }
  return lines.join('\n');
}

// What the next task is and why — the positioning text a fresh session
// needs, printed on stdout so it can be captured, piped, or pasted
// without the verdict above riding along.
export function formatPosition(state) {
  const lines = [];
  lines.push('NEXT');
  if (state.next === null) {
    const openTasks = state.graph.total - state.graph.counts.complete;
    lines.push(
      openTasks === 0
        ? '  (none — every task in the graph is complete)'
        : '  (none ready — no task has all dependencies complete)',
    );
  } else {
    const { task, intent } = state.next;
    lines.push(`  ${task.id}   ${task.layer}   ${task.objective}`);
    lines.push('');
    lines.push('WHY');
    lines.push(`  intent "${intent.id}" — ${intent.goal}`);
    lines.push(`  outcome: ${intent.outcome}`);
    lines.push('  no incomplete dependencies');
    if (state.next.dependents.length > 0) {
      lines.push(`  ${state.next.dependents.length} task(s) blocked downstream of it`);
    }
  }
  return lines.join('\n');
}

// A block a fresh session can be started with: where the build is, what
// is next, what is blocked. Every line is read from the graph, git
// history, or the working tree — nothing here is advice or inference.
export function formatHandoff(state) {
  const { graph } = state;
  const lines = [];
  lines.push('HEDGEHOG HANDOFF');
  lines.push('');
  lines.push('BUILD');
  lines.push(`  ${graph.counts.complete} of ${graph.total} task(s) complete`);
  if (state.head) lines.push(`  HEAD  ${state.head}`);
  lines.push('');
  lines.push('BOUNDARY');
  lines.push(
    state.undecidable
      ? '  undecidable'
      : state.reached
        ? '  reached'
        : '  not reached',
  );
  for (const condition of state.conditions) {
    lines.push(`  ${mark(condition)} ${condition.label} — ${condition.detail}`);
  }
  lines.push('');
  lines.push(formatPosition(state));
  if (state.next !== null) {
    const scopeGlobs = JSON.parse(state.next.task.scope_globs);
    lines.push('');
    lines.push('ALLOWED SCOPE');
    for (const glob of scopeGlobs) lines.push(`  ${glob}`);
    lines.push('');
    lines.push('VERIFICATION');
    lines.push(`  ${state.next.task.verify_command}`);
  }
  lines.push('');
  lines.push('IN FLIGHT');
  if (graph.inFlight.length === 0) {
    lines.push('  (none)');
  } else {
    for (const task of graph.inFlight) {
      lines.push(`  ${task.id}   ${task.layer}   ${task.status}   owner: ${task.lease_owner}`);
    }
  }
  lines.push('');
  lines.push('BLOCKED');
  if (state.stalled.length === 0) {
    lines.push('  (none)');
  } else {
    for (const task of state.stalled) {
      lines.push(`  ${task.id}   ${task.layer}   ${task.blocked_reason}`);
    }
  }
  if (state.next !== null && state.next.dependents.length > 0) {
    lines.push('');
    lines.push(`BLOCKED DOWNSTREAM OF ${state.next.task.id}`);
    for (const dep of state.next.dependents) {
      lines.push(`  ${dep.id}   ${dep.layer}`);
    }
  }
  return lines.join('\n');
}
