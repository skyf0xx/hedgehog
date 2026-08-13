## This project's core: adopted (brownfield)

Hedgehog was adopted onto this repo's existing codebase by
`hedgehog-adopt` rather than building a workspace from scratch. The graph
here covers **new change only** — it is not a map of this repo, and it
never will be. Pre-existing code is context to read and respect, never a
node in the build graph.

- **`.hedgehog/core.yaml`** — a linear chain of change-order layers (no
  module axis), each `verify` command drawn from this repo's own
  test/lint/typecheck commands, confirmed at adoption time. `hedgehog
  plan` compiles the build graph from it.
- **`.hedgehog/adoption.md`** — the rationale: what the repo's own
  commands are, why the layers are ordered the way they are, and what
  `hedgehog-adopt` deliberately chose not to model.

Read `adoption.md` to know what each layer covers and why. There is no
`core-design.md` on this core — `hedgehog-adopt` never designs a stack or
proposes converting this repo toward one; it only wraps the commands and
seams already here.

**Coverage is partial, always.** `hedgehog status` and `hedgehog boundary`
describe the state of work under discipline, not the state of this repo.
A file with no entry under `hedgehog why` was never touched by Hedgehog —
that's expected on an adopted repo, not a bug.

**The packet is what actually runs**, same as any other core: `hedgehog
plan` copies each layer's scope globs, verify command, and commit message
onto the task row at compile time, and the packet is gated against that
row, not against a live re-read of `core.yaml`. See `hedgehog-authored-
loop`'s "core.yaml vs. the packet" for the drift/reconcile mechanics —
they apply here unchanged.

### The skills — invoke these, don't improvise

- **`hedgehog-authored-loop`** — every unit of change: `hedgehog next`
  emits the packet for one ready layer, `layer-eng` builds it, `hedgehog
  verify` gates and commits it. Also holds the Correction Protocol and
  this core's Stop Condition (per-change here, not whole-graph — see
  below).
- **`hedgehog-adopt`** — run again whenever new change-work enters play:
  adds one or more intents for the change (goal, outcome, which seam it
  touches) and runs `hedgehog plan`. Never re-reads the whole repo and
  never re-proposes the layer chain — that was fixed at adoption time.

### The agents — delegate the judgment calls

- **`planner`** — routes new change-work here via `hedgehog intent add`
  once this repo is under adoption; does not re-run intake or re-decide
  the core.
- **`layer-eng`** — builds one layer per `hedgehog next` packet, working
  from the packet's ALLOWED SCOPE. Reports the work done; never commits
  it.
- **`reviewer`** — judges only the unit under change, never pre-existing
  code the current work didn't touch. A day-one dump of legacy findings
  is out of scope by design — see `adoption.md`.
- **`tweaker`** — adjustments to what Hedgehog itself has built under
  this adoption; not a channel for legacy-code cleanup.

## The constants (do not deviate)

### Stack: not Hedgehog's to choose

This repo's language, package manager, and tooling are whatever they
already were before adoption. Hedgehog never proposes converting them
toward a Golden Core's stack — not even as a suggestion. Every `verify`
command in `.hedgehog/core.yaml` is one of this repo's own commands.

### Layout

```text
.hedgehog/
  hedgehog.db      the build graph — intents, compiled tasks, verifications, committed to git
  core.yaml        the change-order layer chain, scope, verification, commit messages — locked
  adoption.md      the rationale behind core.yaml, and this repo's own commands — write-once
```

### Core rules

- **Change-scoped only.** No task ever describes pre-existing code as
  work to do. A file with no artifact record was never built by
  Hedgehog — `hedgehog why` says so plainly rather than erroring.
- **One layer, one commit**, in the exact message `.hedgehog/core.yaml`
  names for that layer.
- **Scope is the boundary**, more load-bearing here than on a greenfield
  core: on an unfamiliar codebase, blast radius is the primary risk, and
  scope enforcement is the only mechanism that bounds it.
- **The layer's own `verify` command — this repo's own command — gates
  every commit.** Never weaken it to clear a gate.
- **No global Stop Condition.** Adoption has no terminal state: it is the
  permanent way change lands on this repo from here on, not a project
  that finishes. "Done" is per-change (`hedgehog boundary` on the current
  intent), never whole-graph.
- **Fix wrong layers at the source** via the Correction Protocol — never
  a downstream workaround.
- **The layer chain itself is locked.** A layer in the wrong place or a
  missing seam is a `hedgehog-adopt` re-run (adding a layer, never
  reshaping history), not a quiet edit to `core.yaml`.
