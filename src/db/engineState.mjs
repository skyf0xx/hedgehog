// The set of paths every scope-facing check in this engine excludes
// before judging what an agent (or a fast-path) actually touched: the
// build graph file and its sidecars, the commit lock, the star-prompt
// state file, and every directory a build-graph command writes its own
// committed record into (`friction add`, `override add`, `intent add`/
// `db rebuild`, `reconcile confirm`, `debt add`/`decision add`, a no-op
// completion, a fast-path). None of these is ever a layer's own work, so
// a path under one of them is never attributable to whatever task or
// intent happened to be active when it changed.
//
// verify.mjs's scope gate and fastpath.mjs's scope check both need
// exactly this predicate; this module exists so it has one definition
// instead of two that could drift apart.

import { DB_PATH } from './init.mjs';
import { LOCK_PATH } from './commitLock.mjs';
import { FRICTION_DIR } from './friction.mjs';
import { OVERRIDES_DIR } from './overrides.mjs';
import { INTENTS_DIR } from './intent.mjs';
import { RECONCILED_DIR } from './reconcile.mjs';
import { NOTES_DIR } from './notes.mjs';
import { NOOP_DIR } from './noop.mjs';
import { COMMUNITY_PATH } from './community.mjs';

// `FASTPATH_DIR` is deliberately not imported here: fastpath.mjs needs
// this module's predicates for its own scope check, and importing
// FASTPATH_DIR from fastpath.mjs here would make that a cycle. Its caller
// there passes it in instead (see fastpath.mjs's own use of
// isBuildGraphStatePath).
export const BUILD_GRAPH_STATE_DIRS = [
  FRICTION_DIR,
  OVERRIDES_DIR,
  INTENTS_DIR,
  RECONCILED_DIR,
  NOTES_DIR,
  NOOP_DIR,
];

export function isBuildGraphStatePath(path, extraDirs = []) {
  return [...BUILD_GRAPH_STATE_DIRS, ...extraDirs].some(
    (dir) => path === dir || path.startsWith(`${dir}/`),
  );
}

export function isEngineStatePath(path, extraDirs = []) {
  return (
    path === DB_PATH ||
    path.startsWith(`${DB_PATH}-`) ||
    path === LOCK_PATH ||
    path === COMMUNITY_PATH ||
    isBuildGraphStatePath(path, extraDirs)
  );
}
