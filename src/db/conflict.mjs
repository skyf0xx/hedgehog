// Conflict predicate between two tasks — the scheduler's basis for which
// claimed tasks may run together. See hedgehog-persistent-build-graph.md,
// "Claims" / concurrent execution, for the exclusive/scope/verify ordering
// and the "verify radius defaults to scope" rule.

// Path-segment-wise prefix before the first wildcard character. A glob
// with no wildcard is a literal path and is its own full prefix.
// Exported so core.mjs's verify-radius checks reason in exactly the glob
// algebra the scheduler decides conflicts with, rather than a second,
// drifting copy of it.
export function globPrefix(glob) {
  const wildcard = glob.search(/[*?[]/);
  const literal = wildcard === -1 ? glob : glob.slice(0, wildcard);
  const segments = literal.split('/');
  // A partial trailing segment (e.g. "ord" from "libs/ord*") isn't a
  // complete path segment, so it's dropped rather than compared as one.
  segments.pop();
  return segments;
}

// True if one glob's segment prefix is a segment-wise prefix of the
// other's (either direction), including equality — never a raw substring
// compare, so "libs/ord*" and "libs/orders/**" don't falsely overlap.
function globsOverlap(globA, globB) {
  const a = globPrefix(globA);
  const b = globPrefix(globB);
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function scope(task) {
  return JSON.parse(task.scope_globs);
}

// Defaults to `scope(task)` when `verify_radius` is unset — a task with no
// declared radius is assumed to verify only what it touches, the
// optimistic default the spec calls for.
export function verifyRadius(task) {
  if (task.verify_radius == null) return scope(task);
  return JSON.parse(task.verify_radius);
}

export function scopesOverlap(globsA, globsB) {
  return globsA.some((globA) => globsB.some((globB) => globsOverlap(globA, globB)));
}

export function conflicts(a, b) {
  if (a.exclusive || b.exclusive) return 'exclusive';
  if (scopesOverlap(scope(a), scope(b))) return 'scope';
  if (scopesOverlap(verifyRadius(a), verifyRadius(b))) return 'verify';
  return null;
}
