---
name: hedgehog-authored-loop
description: Use for every unit of work on an authored core (`.hedgehog/core.yaml` present) once bootstrap has closed — building one layer per claimed packet, gated by `hedgehog verify` and committed one layer at a time. Triggers on "next step", "what's next", "build this", or the start of any work session on a bootstrapped authored-core project. Also covers the Correction Protocol and the Stop Condition for this core.
---

# Hedgehog Authored Loop

The operating loop for a bootstrapped project on an authored core:
`hedgehog claim` reserves the packet(s) for ready layers, `layer-eng`
builds each, `hedgehog verify` gates and commits it. The build graph
(`.hedgehog/hedgehog.db`) is the live list — query it via `hedgehog
status`/`hedgehog ready`, never re-derive state from prose.

## Where this core's shape lives

An authored core's layer sequence and stack were designed for this
project by `hedgehog-core-design`. Two files carry them, and both are
locked:

- **`.hedgehog/core.yaml`** — the compiled authority: layer order, each
  layer's `scope` globs, `verify` command, commit message. `hedgehog
  plan` compiled the graph from it; every packet is generated from it.
- **`.hedgehog/core-design.md`** — the rationale: system shape, stack,
  what each layer owns and why it sits where it does, and the module-axis
  decision.

Read `core-design.md` at the start of a session to know what this project
is; trust `core.yaml` and the packet as authoritative if the two ever
seem to disagree.

## Module axis

`hedgehog-core-design` decided one of two graph shapes, recorded in
`core-design.md`:

- **Module axis** — the layer chain instantiates once per intent, so the
  graph is intents × layers. A packet's `module` field names which intent
  the layer is being built for, and scope globs carry `{module}` filled
  in. Every intent walks the full sequence.
- **Linear chain** — one pass total, one task per layer, no `module`
  dimension. The project is built once, front to back.

`hedgehog claim` handles both — it reserves whatever is ready. This
matters for reading `hedgehog status`: on a module axis, "done" means
every intent completed every layer, not the last layer completed once.

Concurrent execution pays off on a module axis and not on a linear chain.
Intents are independent of each other, so their layer tasks can be
claimed and built together whenever the scheduler's conflict predicate
clears them — `hedgehog claim --count N --owner <owner>` can return more
than one task at a time. A linear chain has only one task ready at any
point, so `hedgehog claim --count N` naturally returns 1 regardless of
`N`; fan-out buys nothing there. This is a factor in the module-axis-vs-
linear-chain choice `hedgehog-core-design`'s Step 4 makes, not just a
runtime detail.

## The Loop (every unit of work)

1. **Run `hedgehog claim --count N --owner <owner>`.** `<owner>` is this
   session. Claim is atomic and lease-based, and returns up to N task
   packets (STATUS/INTENT/RELEVANT RULES/WHY NOW/BLOCKED
   DOWNSTREAM/ALLOWED SCOPE/VERIFICATION each) that the scheduler has
   already verified are safe to run together — trust it: a packet is
   never handed out unless its dependencies are `complete` and it
   doesn't conflict with anything else in the batch. `--count` is a
   maximum, not a promise. `hedgehog ready` previews the claimable/held-
   back split without claiming anything.
2. **Dispatch each claimed packet to its own `layer-eng` subagent** — in
   ONE message with parallel tool calls when there's more than one — along
   with the reminder to read `.hedgehog/core-design.md` for what its
   layer owns.
3. Each agent **runs the packet's VERIFICATION command on its own work**
   as a sanity check before reporting back — necessary, not sufficient.
   Per task, per agent: the agent reports the work as done; it does not
   move the task and does not commit.
4. **As each report arrives, verify it — one at a time, serially.** Run
   `hedgehog verify <task-id> --owner <owner>`. It checks the touched
   files against the packet's ALLOWED SCOPE, runs the layer's
   VERIFICATION command, and on a pass writes the commit (the exact
   message from `core.yaml`, plus the updated build graph) and unlocks
   the next layer. On a scope violation or a failing check, the task
   moves to `blocked` with a `blocked_reason` of `scope_violation` or
   `verification_failed`, and nothing downstream unlocks. Fix the work,
   then run `hedgehog retry <task-id>` to return the task to `planned`,
   claim it again, and verify again — `hedgehog verify` only accepts a
   task you currently hold in `building`, so a blocked task has to go
   back through `retry` and `claim` first. Don't hand-commit around it.

   A `blocked` task is not pickable by `hedgehog claim`, so `hedgehog
   status` lists it under NEEDS ATTENTION with the task id to retry.
   If `hedgehog claim` returns nothing and the graph isn't actually done,
   fix that task — don't treat it as "nothing left to do."
5. **Repeat** — `hedgehog claim --count N --owner <owner>` again for the
   next batch.

Each `hedgehog verify` call commits exactly one layer, built right for
what's known now; a wrong layer is fixed forward later via the Correction
Protocol.

## Intra-layer conventions

An authored core's stack varies by project, so the conventions inside a
layer come from two places rather than a fixed table: the stack's own
idioms (a Rust project's error handling is `Result`, a TypeScript
project's is thrown typed errors), and whatever the earlier layers
already established on disk. Read before writing, and stay consistent
with what's there.

Three hold on every authored core regardless of stack:

- **A layer owns one artifact, reached through the interface
  `core-design.md` named.** The layer below is consumed through that
  interface, not reached around — the boundary is what makes the layer
  independently verifiable.
- **Errors carry their meaning.** A failure surfaces as the stack's
  idiomatic typed failure with a domain-meaningful name, not a bare
  string or a silent empty return a caller has to guess at.
- **Each layer's tests live inside that layer's scope** and run under its
  own `verify` command. A layer whose command passes with no tests
  certifies nothing.

## Friction log

Same mechanic as `hedgehog-loop`'s Friction log — log real friction via
`hedgehog friction add "<note>" [--task <task-id>]`, `tweaker` reads it at
the Stop Condition.

An authored core's own layer sequence is a live subject for this log: a
layer that keeps needing scope it doesn't have, or two layers that are
always touched together, is design feedback worth recording even when the
Correction Protocol resolves the immediate case.

## Correction Protocol

Same 5-step mechanic as `hedgehog-loop`'s Correction Protocol (quiesce,
patch the upstream layer in place, fast-forward every dependent layer as
its own commit, commit messages as the explanation, resume the loop with
`hedgehog claim`) — read that skill's version for the full statement,
including why quiescing rather than stopping in-flight work is strictly
correct. One difference: if the patched layer produces a build artifact
that downstream layers or a running dev process consume (a compiled
package, a generated client, a bundled asset), rebuild it before
re-verifying — an unbuilt patch looks unchanged to anything reading the
built output.

When the correction is to the **layer sequence itself** — a layer in the
wrong place, a missing layer, a scope glob that never fits — that's a
`planner` case, not a patch: `.hedgehog/core.yaml` and
`.hedgehog/core-design.md` are locked, and changing them re-shapes every
task the graph compiles. Stop, say what the design got wrong, and hand to
`planner`.

### Post-build entry

Same shape as `hedgehog-loop`'s Post-build entry — `tweaker` routes here
for something structural, there's no task to stop and no loop to resume
(return to `tweaker` instead), every touched task stays `complete` and is
fixed forward in new commits. Verify each patched layer with its own
`verify` command from `.hedgehog/core.yaml`.

## Layer Transition Checks

Before starting a layer that depends on an earlier one, confirm the
earlier layer's task is `complete` in `hedgehog status` — `hedgehog claim`
already guarantees this, so this check matters only when picking work up
by hand after an interruption.

Use the `reviewer` agent at the point a layer closes for the last intent
on a module axis, or at the last layer on a linear chain — it checks what
the mechanical gate can't: whether the layer boundary `core-design.md`
described actually held, and whether the interfaces between layers stayed
the ones that were designed.

## Rules

- **Concurrent within a layer, bounded by the scheduler.** On a module
  axis, tasks for the same layer across different intents can run
  together when `hedgehog ready` shows them both claimable — never assume
  two tasks are safe together without checking. On a linear chain only
  one task is ever ready, so this rule is moot in practice. Either way, a
  layer starts only once the one before it (for that intent) passes its
  own verification.
- **A wrong layer gets fixed at its source** — the Correction Protocol,
  not a downstream workaround.
- **The layer's own `verify` command gates every commit.** Never weaken
  it to clear a gate.
- **Scope is the boundary.** A layer writes inside its ALLOWED SCOPE and
  nowhere else; a change that needs to land elsewhere is a correction,
  not a wider write.
- **`.hedgehog/core.yaml` and `.hedgehog/core-design.md` are locked.**
  Changing either is a `planner` decision through the Correction
  Protocol.

## Stop Condition

Same fresh-context handoff as `hedgehog-loop`'s Stop Condition (offer it
once every task is `complete`, nothing is still in flight — check
`hedgehog status`'s IN FLIGHT section or run `hedgehog quiesce` — and
scope isn't genuinely ambiguous; the permanent record is the committed
intents, friction log, and `core.yaml`, not `.hedgehog/hedgehog.db`,
which is gitignored and derived; a `tweaker` session in a *new* chat
window handles adjustments, using the same paste-in prompt that skill's
Stop Condition gives). On a module axis, "every task complete" means
every intent through every layer, not the last layer completed once.

**New scope** — a new intent on the module axis, anything beyond
adjusting what exists — goes to `planner`, which runs
`hedgehog-planning-intake`'s Re-entry pass: it adds intents for the new
work without re-running planning from scratch, compiling them through
the layer sequence `.hedgehog/core.yaml` already defines, and without
disturbing anything already built. A completed build is extendable, not
sealed. Changing the **layer sequence itself** is the separate case
above — a Correction Protocol entry, not a re-entry pass.

Don't start making tweaks or planning new scope in the current,
already-large context; that's what the fresh session is for.
