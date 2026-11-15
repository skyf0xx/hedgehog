// Cross-branch commit-history visibility for `hedgehog ready`/`claim`/
// `status`/`reconcile`, run live inside a `git worktree` checkout.
// `hedgehog db rebuild` (rebuild.mjs#loadCommitSubjects) reads only the
// current branch's own `git log`.
//
// Each worktree carries its own `.hedgehog/hedgehog.db` (worktree.mjs's
// file header), and no DB row is ever copied between them or from a
// worktree to trunk: the build graph is a pure function of committed
// files plus git history. A task completed and committed on trunk (or on
// a sibling worktree's branch) is therefore absent from a different
// worktree's own `tasks.status`, while its commit sits in the same
// repository's object store, reachable from a local ref this checkout
// can see.
//
// This module answers the question rebuild.mjs#loadCommitSubjects
// answers for the current branch (did a commit with this exact subject
// ever happen), widened to `git log --all`: every local branch's
// reachable history, which covers trunk and every open worktree's
// branch. A project that has never used worktrees has one branch with
// commits, so `--all` reads the same history `git log` does there.
//
// ── ambiguous commit messages are left unresolved ──────────────────────
//
// rebuild.mjs#markCompletedTasks resolves a commit_message shared by more
// than one task (the linear-chain core case — authored/adopted, no
// `{module}` axis) with an ordering+consumption fixpoint walk over
// `dependencies` rows that writes `tasks.status` as it goes. That walk is
// bound to its DB write path, and a read-only copy of it here would drift
// from it.
//
// So a task whose `commit_message` is NOT unique across the whole graph
// is left OUT of `resolvableMessages` (see `buildCrossBranchIndex`).
// Every caller (claim.mjs, ready.mjs indirectly, status.mjs,
// reconcile.mjs) treats "not in the index" as "can't determine — leave
// blocked", the safe direction: a cross-worktree dependency this module
// can't resolve stays blocked, never incorrectly unblocked. The
// module-axis case, which `full-stack-app`/`pwa-app`/`landing-page`
// compile, has a `commit_message` unique to each task by construction
// (the layer's `commit` template interpolates `{module}`).
import { git } from './git.mjs';

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
function subjectCountsFrom(refArgs) {
  let output;
  try {
    output = git(['log', ...refArgs, '--topo-order', '--format=%H%x00%s']);
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
  return subjectCountsFrom(['--all']);
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
  return subjectCountsFrom([]);
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
