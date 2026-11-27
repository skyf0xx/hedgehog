# How we would like patches made

## Size and scope of a fix
- Fix the root cause in the shared helper when several call sites share
  it; otherwise keep the change to the faulty function. No unrelated
  refactoring.

## Code style
- Plain ES modules for Node 22, no new dependencies. Match the
  surrounding code; it must pass `npm run lint`.
- Comments only for a non-obvious constraint or invariant. Never a
  comment that narrates the fix or its history.

## Tests
- Add one reproduction under `repro/` named for the behavior
  (for example `repro/core-tarball-path-traversal.mjs`). It must fail
  before the fix and pass after, and use `repro/lib/fixture.mjs` like
  the existing ones. `npm run repro` must pass.

## Branch and commit message
- Against `master`. One Conventional Commits message, for example
  `fix(registry): reject tarball entries outside the package root`.
