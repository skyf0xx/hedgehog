// Cross-branch commit-history visibility for `hedgehog ready`/`claim`/
// `status`/`reconcile`, run live inside a `git worktree` checkout — where
// `hedgehog db rebuild` (rebuild.mjs#loadCommitSubjects) intentionally
// only ever reads the CURRENT branch's own `git log`.
//
// The gap this closes: each worktree carries its own `.hedgehog/hedgehog.db`
// (worktree.mjs's file header), and no DB row is ever copied between them
// or from a worktree to trunk — that invariant is the reason the build
// graph is a pure function of committed files plus git history in the
// first place. But "current git history" was, until now, silently read as
// "the current branch's history" everywhere a live command checked whether
// a dependency was done: claim.mjs's CLAIMABLE_TASKS_SQL joins only the
// current DB's own `tasks.status`, and reconcile.mjs's `commitsSince`
// ranges over `HEAD` alone. A task completed and committed on trunk (or on
// a sibling worktree's branch) is therefore invisible to a different
// worktree's own DB even though the *commit* — the actual source of truth
// — is sitting right there in the same repository's object store, reachable
// from a local ref this checkout can already see.
//
// This module answers the same question rebuild.mjs#loadCommitSubjects
// answers for the current branch (did a commit with this exact subject
// ever happen), widened to `git log --all` — every local branch's
// reachable history, which covers trunk and every open worktree's branch,
// since a worktree's branch is still a local ref of the same checkout.
// `--all` is exactly the right and only widening: it costs nothing beyond
// one extra `git log` flag, needs no new git remotes or fetches, and a
// project that has never used worktrees has exactly one branch with any
// commits — `git log --all` degenerates to `git log` for it, so this
// function is a strict no-op there (acceptance criterion: zero behavior
// change for a project that never opened a worktree).
//
// ── the ambiguous-commit-message case: a documented, deliberate gap ────
//
// rebuild.mjs#markCompletedTasks resolves a commit_message shared by more
// than one task (the linear-chain core case — authored/adopted, no
// `{module}` axis) via an ordering+consumption fixpoint walk over
// `dependencies` rows, mutating `tasks.status` directly as it goes. That
// walk is inseparable from the DB write path it drives (UPDATE statements
// interleaved with the fixpoint, `reconciledTaskIds` seeded in up front,
// re-open-on-failed-claim at the end) and rebuild.mjs is explicitly out of
// scope for this change — re-deriving its `positionOf`/`available`/
// `ranAfterPrerequisites` machinery here as a read-only, no-mutation
// sibling would either (a) silently drift from the real algorithm the
// first time either copy changes, which is exactly the "three divergent
// implementations" this file exists to avoid, or (b) require touching
// rebuild.mjs to extract a shared core, which the task constraints forbid.
//
// So: a task whose `commit_message` is NOT unique across the whole graph
// (the ambiguous / linear-chain case) is left OUT of `subjectsAllBranches`
// entirely by this module — see `buildCrossBranchIndex`'s filtering below.
// Every caller (claim.mjs, ready.mjs indirectly, status.mjs, reconcile.mjs)
// then treats "not present in the index" as "can't determine — leave
// blocked", the safe direction: a cross-worktree dependency this module
// can't resolve stays exactly as blocked as it already was, never
// incorrectly unblocked. The module-axis case — the overwhelmingly common
// one, since it's what `full-stack-app`/`pwa-app`/`landing-page` compile —
// has a `commit_message` unique to each task by construction (the layer's
// `commit` template interpolates `{module}`) and is fully solved.
import { execSync } from 'node:child_process';

// Memoized per `git log --all` call: a Map from commit subject to the
// number of times it occurs, newest-history-order irrelevant here (unlike
// rebuild.mjs's positional Map, this module never needs to order two
// candidate commits against each other, since it only ever answers for the
// unambiguous case where any one occurrence is as good as any other).
// Re-running `git log --all` per call rather than caching across calls:
// every entry point here (claim, ready, status, reconcile) is invoked at
// most once per CLI process, so there is no repeated-call cost to amortize
// within a run, and caching across separate `hedgehog` invocations would
// risk serving a stale answer to a long-lived process (the graph server)
// after a sibling worktree commits.
function subjectCountsFrom(gitArgs) {
  let output;
  try {
    output = execSync(`git log ${gitArgs} --topo-order --format=%H%x00%s`, { encoding: 'utf8' });
  } catch {
    // No commits reachable from the requested ref set yet (a brand-new
    // repo, or — for the current-branch-only call — a worktree whose
    // branch predates its very first commit). Every subject is absent,
    // which is the correct, honest answer.
    return new Map();
  }
  const counts = new Map();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [, subject] = line.split('\0');
    if (subject === undefined) continue;
    counts.set(subject, (counts.get(subject) ?? 0) + 1);
  }
  return counts;
}

function loadAllBranchesSubjectCounts() {
  return subjectCountsFrom('--all');
}

// The current branch's own subject counts — i.e. exactly what
// rebuild.mjs#loadCommitSubjects would see (membership only; this module
// never needs commit position, only "did this subject occur here at
// all"). Used by buildCrossBranchIndex below to detect the one case
// cross-branch crediting must refuse: a task reopened via the Correction
// Protocol (claim.mjs#reopenTask) after an EARLIER commit with the same
// subject already landed on this very branch. That earlier commit is
// exactly as visible via `--all` as any genuine cross-branch completion —
// nothing about the subject string distinguishes "this is a fresh
// completion on another branch" from "this is the stale completion this
// branch itself already reset". A task whose current DB status is not
// `complete` but whose commit_message already appears on THIS branch is
// therefore excluded from resolvableMessages entirely: crediting it would
// resurrect a completion this worktree's own history has already
// superseded, which is worse than the safe "leave it blocked, the
// dependency isn't obviously satisfied" default this whole module commits
// to elsewhere.
function loadCurrentBranchSubjectCounts() {
  return subjectCountsFrom('');
}

// Builds the set of commit_messages this module can safely credit as
// "happened somewhere in this repository's visible history" — i.e. every
// subject that occurs in `git log --all` AND belongs, in `db`, to exactly
// one task. A subject occurring for two distinct reasons (two different
// tasks in this graph legitimately share a commit_message — the ambiguous
// linear-chain case) is deliberately excluded even though it does appear
// in history, per the module-header comment above: this function cannot
// tell which of the sharing tasks a given commit actually credits, and
// guessing is worse than leaving both blocked.
//
// `db` is read only for `tasks.commit_message` grouping — never written.
export function buildCrossBranchIndex(db) {
  const tasks = db.prepare('SELECT id, commit_message, status FROM tasks').all();
  const messageCounts = new Map();
  const statusByMessage = new Map();
  for (const task of tasks) {
    messageCounts.set(task.commit_message, (messageCounts.get(task.commit_message) ?? 0) + 1);
    statusByMessage.set(task.commit_message, task.status);
  }

  const subjectCounts = loadAllBranchesSubjectCounts();
  const currentBranchCounts = loadCurrentBranchSubjectCounts();
  const resolvableMessages = new Set();
  for (const [message, taskCount] of messageCounts) {
    if (taskCount !== 1) continue; // ambiguous in THIS graph — see header comment
    const total = subjectCounts.get(message) ?? 0;
    if (total === 0) continue; // not seen on any branch
    const onThisBranch = currentBranchCounts.get(message) ?? 0;
    // Reopen guard (see loadCurrentBranchSubjectCounts): if every
    // occurrence of this subject anywhere (`total`) is already accounted
    // for on THIS branch (`onThisBranch >= total`) and the task is still
    // not `complete` here, there is no occurrence anywhere else to credit
    // — the one this branch already has is exactly the completion a
    // Correction Protocol reopen (claim.mjs#reopenTask) superseded, and
    // `--all` has nothing further to offer. Strictly fewer occurrences on
    // this branch than `total` means at least one occurrence exists on
    // SOME other branch this worktree cannot otherwise see, which is
    // exactly the genuine cross-branch completion this module exists to
    // surface — trusted even when this branch also independently carries
    // its own earlier, now-superseded copy of the same subject.
    if (onThisBranch >= total && statusByMessage.get(message) !== 'complete') {
      continue;
    }
    resolvableMessages.add(message);
  }

  return { resolvableMessages };
}

// Returns true if `task` (a `tasks` row carrying `commit_message`, and
// unique in `db` for that message) can be credited complete from
// cross-branch history, per the index built above. Callers pass the same
// `index` across many tasks in one call rather than rebuilding it per
// task — one `git log --all` per CLI invocation, mirroring
// rebuild.mjs#loadCommitSubjects's own one-call-per-run shape.
export function commitMessageExistsAnywhere(task, index) {
  return index.resolvableMessages.has(task.commit_message);
}

// Convenience for a caller that only has a raw commit_message string (no
// task row) — reconcile.mjs's evidence path doesn't need the
// per-task-uniqueness guard, since it isn't resolving a *dependency*'s
// status, only widening the commit window it reads from. Kept separate
// from commitMessageExistsAnywhere (which is intentionally conservative
// about ambiguity) so this narrower use doesn't inherit a guard it has no
// use for.
export function anyCommitAnywhereWithSubject(subject) {
  return (loadAllBranchesSubjectCounts().get(subject) ?? 0) > 0;
}
