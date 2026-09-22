// Possibly-satisfied detection: a `planned` task whose scope_globs are
// already fully covered by git-tracked, committed files with nothing
// pending inside that scope — the heuristic nudge toward `hedgehog
// reconcile` for work that landed under a different task's or a
// different intent's commit, so `db rebuild`'s exact-commit-subject
// attribution (rebuild.mjs#markCompletedTasks) never had a subject to
// credit it against and the task sits `planned` forever with no signal.
//
// This is evidence, not proof, exactly like reconcile.mjs's
// gatherEvidence: a scope glob resolving to tracked, clean paths says
// the files a task would have written already exist and nothing is
// mid-edit there. It says nothing about whether the task's objective was
// actually met by that content — a `planned` task can legitimately share
// a glob with pre-existing, unrelated code that still needs real work.
// False positives are expected and acceptable; this only flags "look at
// this", it never completes anything itself.
//
// Uses the same git pathspec mechanism verify.mjs's own scope gate uses
// (`:(glob)<glob>` handed to git literally, no in-process glob dialect of
// its own to keep in sync with core.mjs's), rather than matchesGlob's
// witness-path walk — a witness path proves non-containment against a
// *set* of globs (core.mjs's own use, and coverage's), not "which real
// files in this repo currently match one glob", which only git's own
// pathspec matcher can answer without re-walking the whole tree.

import { execFileSync } from 'node:child_process';
import { isEngineStatePath } from './engineState.mjs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function pathspecsFor(scopeGlobs) {
  return scopeGlobs.map((glob) => `:(glob)${glob}`);
}

// Tracked files under a task's scope, minus engine-state paths — the
// same exclusion verify.mjs's gate applies, so a task whose scope happens
// to reach into `.hedgehog/` never gets flagged on the build graph's own
// bookkeeping.
function trackedPathsInScope(scopeGlobs) {
  let output;
  try {
    output = git(['ls-files', '--', ...pathspecsFor(scopeGlobs)]);
  } catch {
    return [];
  }
  return output
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !isEngineStatePath(p));
}

// Modified, staged, or untracked paths under a task's scope — anything
// `git status --porcelain` reports there means the scope is still
// mid-edit, the opposite of "already satisfied".
function dirtyPathsInScope(scopeGlobs) {
  let output;
  try {
    output = git(['status', '--porcelain', '--', ...pathspecsFor(scopeGlobs)]);
  } catch {
    return [];
  }
  return output
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .filter((p) => !isEngineStatePath(p));
}

// Every `planned` task whose scope_globs resolve to at least one tracked
// file and zero dirty ones — a task with an empty scope match (nothing in
// the repo yet touches its globs at all) is not flagged, since that is
// simply unstarted work, not possibly-satisfied work.
//
// Only `planned` is read, not `ready`: a `ready` task already cleared
// every dependency and is next.mjs/claim.mjs's own queue to hand out —
// flagging it here would tell an operator to reconcile work a claim is
// about to pick up anyway. `building`/`verifying` are leased and mid-flight
// by definition; `blocked` has its own NEEDS ATTENTION path; `complete` is
// done. `planned` is the one status this signal exists for: work nothing
// has looked at yet, sitting behind whatever unlocked it.
const PLANNED_TASKS_SQL = `
  SELECT id, layer, objective, scope_globs FROM tasks
  WHERE status = 'planned'
  ORDER BY priority, id;
`;

export function possiblySatisfiedTasks(db) {
  const tasks = db.prepare(PLANNED_TASKS_SQL).all();
  const flagged = [];
  for (const task of tasks) {
    const scopeGlobs = JSON.parse(task.scope_globs);
    if (scopeGlobs.length === 0) continue;
    const tracked = trackedPathsInScope(scopeGlobs);
    if (tracked.length === 0) continue;
    const dirty = dirtyPathsInScope(scopeGlobs);
    if (dirty.length > 0) continue;
    flagged.push({ id: task.id, layer: task.layer, objective: task.objective, paths: tracked });
  }
  return flagged;
}

export function formatPossiblySatisfied(flagged) {
  const lines = [`POSSIBLY SATISFIED  ${flagged.length}`];
  for (const { id, layer, paths } of flagged) {
    lines.push(`  ${id}   ${layer}   ${paths.length} tracked path${paths.length === 1 ? '' : 's'} in scope, none pending`);
  }
  lines.push('');
  lines.push(
    '  Scope glob already covered by clean, tracked files — not proof the objective was met.' +
      ' See: hedgehog reconcile',
  );
  return lines.join('\n');
}
