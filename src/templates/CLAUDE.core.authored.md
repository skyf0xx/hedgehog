## This project's core: authored

This project's core was designed for it by `hedgehog-core-design` at
planning intake, rather than taken from a shipped Golden Core. The layer
sequence, the stack, and each layer's file scope and verification live in
two files, and both are locked:

- **`.hedgehog/core.yaml`** — the design authority: `id`, the layer
  order, and per layer its `scope` globs, `verify` command, and commit
  message. `hedgehog plan` compiled the build graph from this.
- **`.hedgehog/core-design.md`** — the rationale: the system shape (what
  this project fundamentally is), the stack and why it was chosen, a line
  per layer on what it owns and why it sits where it does, and the
  module-axis decision.

Read `core-design.md` to know what this project is and what each layer
owns.

**The packet is what actually runs.** `hedgehog plan` *copies* each
layer's scope globs, verify command and commit message onto every task
row at compile time, and from then on the row — surfaced as the packet
`hedgehog next`/`claim` emits — is what the engine reads. Editing
`core.yaml` afterwards does not reach tasks already compiled, and a plain
`hedgehog plan` re-run won't either (compiling an intent marks it
`active`, and `plan` only looks at pending ones). So if the packet and
`core.yaml` disagree, the packet is what your work will be gated
against — reconcile them rather than picking a winner:

- `hedgehog status` reports a **DRIFT** section naming every task whose
  compiled fields no longer match `core.yaml`, and what differs.
- `hedgehog plan --recompile` rewrites those fields from the current
  `core.yaml` on tasks that haven't started, and refuses (naming each
  one) tasks that are `building`, `verifying`, `complete` or `blocked`.
  `--dry-run` previews; `--include-blocked` opts blocked tasks in.
- A task already built or committed can't be reconciled this way at all
  — that's the Correction Protocol: fix the layer at its source and
  re-run it.

Changing either file re-shapes every task the graph compiles *from then
on*. Both are locked at `hedgehog-core-design`'s Confirm & Lock — a layer
boundary that turns out wrong is a `planner` decision through the
Correction Protocol.

### The skills — invoke these, don't improvise

- **`hedgehog-authored-loop`** — every unit of work once bootstrapped:
  `hedgehog next` emits the packet for one ready layer, `layer-eng`
  builds it, `hedgehog verify` gates and commits it. Also holds the
  Correction Protocol and this core's Stop Condition. Invoke it at the
  start of any build session and for "what's next".
- **`hedgehog-bootstrap-authored-core`** — run **once**, at project
  start, to generate and verify this core's workspace from the stack in
  `core-design.md`. Skip once its `feat(<id>): workspace` commit exists.
- **`conventional-commits`** — when a change spans several layers in one
  working-tree pass and needs splitting back into per-layer commits
  (mainly Correction Protocol cleanups).

### The agents — delegate the judgment calls

- **`planner`** — planning intake (which core applies, then the vendored
  BMAD-METHOD shelf run in full and mined into intents) at project start.
  Owns `.hedgehog/BMAD/`, `.hedgehog/core.yaml`, and
  `.hedgehog/core-design.md`. On first run, hands off to the `bootstrap`
  agent once Confirm & Lock holds. Runs again whenever new work enters
  play — including after the build is complete — taking
  `hedgehog-planning-intake`'s **Re-entry pass**: the BMAD shelf,
  `hedgehog-core-design`, and `bootstrap` are all skipped, new scope is
  mined into additional intents, and `hedgehog plan` compiles them
  through the existing layer sequence without touching anything already
  built. Changing the layer sequence itself is a Correction Protocol
  case, not a re-entry pass.
- **`bootstrap`** — runs `hedgehog-bootstrap-authored-core`'s steps.
  Triggered automatically by `planner` after its first run.
- **`layer-eng`** — builds one layer per `hedgehog next` packet, working
  from the packet's ALLOWED SCOPE and `core-design.md`'s description of
  what that layer owns. Reports the work done; never commits it.
- **`reviewer`** — checks what the mechanical gate can't: whether the
  layer boundaries `core-design.md` described actually held, and whether
  the interfaces between layers stayed the ones that were designed.
- **`tweaker`** — post-build, from a fresh context: takes tweak requests
  one at a time and reviews the friction log.

## The constants (do not deviate)

### Stack (locked)

Named in `.hedgehog/core-design.md`'s stack record — language, package
manager, framework(s), test runner — and realized in the workspace
`hedgehog-bootstrap-authored-core` generated. The stack was chosen
deliberately for this project's system shape; a felt need for a new
library is worth surfacing before adding it, since it usually belongs to
the layer's design rather than to a build step.

### Layout

The layer `scope` globs in `.hedgehog/core.yaml` define where each
layer's code lives — that file is the layout, and it's enforced:
`hedgehog verify` rejects a task that writes outside its own scope.

```text
.hedgehog/
  hedgehog.db         the build graph — intents, compiled tasks, verifications, committed to git
  core.yaml           this core's layer sequence, scope, verification, commit messages — locked
  core-design.md      the design rationale behind core.yaml — write-once, from planner
  BMAD/               vendored BMAD-METHOD shelf's raw output (brief, PR-FAQ, PRD, UX spec, research) —
                       write-once, from planner
```

### Core rules

- **One layer, one commit**, in the exact message `.hedgehog/core.yaml`
  names for that layer.
- **Sequential through the chain.** A layer starts once the one before it
  passes its own verification — `hedgehog next` enforces this.
- **Scope is the boundary.** A layer writes inside its ALLOWED SCOPE and
  nowhere else; a change that needs to land elsewhere is a correction,
  not a wider write.
- **A layer owns one artifact**, reached through the interface
  `core-design.md` named — that boundary is what makes the layer
  independently verifiable.
- **The layer's own `verify` command gates every commit.** Never weaken
  it to clear a gate; a layer whose command passes with no tests
  certifies nothing.
- **Fix wrong layers at the source** via the Correction Protocol — never
  a downstream workaround.
- **The layer sequence itself is locked.** Changing `.hedgehog/core.yaml`
  or `.hedgehog/core-design.md` is a `planner` decision, not a quiet
  edit.
