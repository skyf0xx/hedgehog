// The global commit lock — serializes the git-mutating section of
// `verifyTask` (scope diff, staging, commit) across concurrent processes.
// See BUILD_GRAPH.md, "6. Multiple agents can work at once": two tasks may build concurrently, but git has one working
// tree and one index, so the commit phase itself cannot. `.hedgehog/
// commit.lock` is gitignored in every core's template — it's a runtime
// mutex, not project state.

import { openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { DB_PATH } from './init.mjs';

// Exported so verify.mjs's isEngineStatePath can exclude it from every
// task's scope check — same reasoning as the DB path itself: this file
// is engine-internal, and gate 1's diff would otherwise catch its own
// lock file as an "offending" path the instant it's created.
export const LOCK_PATH = `${DB_PATH.slice(0, DB_PATH.lastIndexOf('/'))}/commit.lock`;

// A lock file older than this is assumed to belong to a process that
// crashed before releasing it (no host-level lock survives a kill -9) —
// stealing it is safer than a build that hangs forever on a dead holder.
const STALE_MS = 5 * 60 * 1000;
const POLL_MS = 100;

function tryAcquire() {
  try {
    // 'wx' is an atomic exclusive create — the one primitive this needs.
    // Two processes racing this call: exactly one gets the fd, the other
    // throws EEXIST. That's the whole mutex; no separate locking library
    // is warranted for one gitignored marker file.
    const fd = openSync(LOCK_PATH, 'wx');
    closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  }
}

function stealIfStale() {
  try {
    const { mtimeMs } = statSync(LOCK_PATH);
    if (Date.now() - mtimeMs > STALE_MS) unlinkSync(LOCK_PATH);
  } catch {
    // Gone already (released between the stat and here) — nothing to do.
  }
}

// Blocks (synchronously spinning the event loop via a busy wait — this
// file has no async caller; verifyTask and everything in it is sync by
// design, see verify.mjs) until the lock is held, then runs `fn` and
// always releases. A crashed holder's lock is stolen after STALE_MS
// rather than wedging every future verify permanently.
export function withCommitLock(fn) {
  const deadline = Date.now() + STALE_MS * 2;
  while (!tryAcquire()) {
    stealIfStale();
    if (Date.now() > deadline) {
      throw new Error(
        `commit lock (${LOCK_PATH}) held past ${STALE_MS * 2}ms — a stuck verify or a bug in lock release`,
      );
    }
    // Synchronous sleep: Atomics.wait blocks the thread without a promise,
    // matching this module's fully-synchronous call chain.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      // Already gone (stolen as stale while we held it past STALE_MS,
      // which the deadline check above should prevent, but releasing a
      // lock that's already gone must not throw over the real result).
    }
  }
}
