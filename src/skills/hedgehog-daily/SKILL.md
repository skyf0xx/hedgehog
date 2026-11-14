---
name: hedgehog-daily
description: Use when a change request lands on a project that already has `.hedgehog/` and no build in flight — a finished build being adjusted, or an adopted repo's next piece of work. Triggers on any "change this", "fix this", "add this" on such a project. Sizes the request against the installed core's own layers and routes it to one of three exits: a tweak made and committed here, change-work through `hedgehog intent add` and the core's loop, or a re-plan. Not for a build still in progress — that is the core's loop skill's own job.
---

# Daily change-work

One gate, three exits, for every change request on a project whose build
graph already exists. It reads the installed core's layer sequence,
scope globs and verify commands from `hedgehog core show`, so it is the
same gate on every core.

The gate exists to stop pricing a two-line edit at the cost of the
largest change the discipline can handle. Routing up is a real decision
with a real cost, taken on stated conditions — not the safe default.

## Entry

1. **`.hedgehog/` exists.** Without it there is no core to read and no
   graph to add to; this skill does not apply.
2. **Nothing is in flight.** `hedgehog status --brief` — one line. If it
   names any task, a build is mid-flight: this gate does not run. Read
   the full `hedgehog status` and hand the request back to the core's own
   loop skill, which owns work in progress.
3. **Run `hedgehog core show`** (`--json` for a parseable form). The
   layer list is the input to every decision below: each layer's `id`,
   `scope` globs, `verify` command, `verify_radius`, `exclusive` and
   `commit` format. Read the output, not a memory of it. The command
   finds the core definition wherever the installed core keeps it.

## The three exits

Decide by the conditions, in order. The first one that holds is the exit.
Re-plan is checked first, and its check is a read to make, not a
suspicion to already hold — do not reach Change-work or Tweak without
having made it.

### Re-plan

The core's own loop skill names which artifact governs this project —
the brief and layer sequence for a shipped core, `.hedgehog/core-design.md`
for an authored one, `.hedgehog/adoption.md` for an adopted one. Read
that artifact, then check:

- Does anything the request needs contradict a statement locked there —
  an interface, a stack choice, a scope boundary?

If it holds, this is Re-plan — regardless of how many layers the request
reaches or whether every file it touches already exists. Route to
`planner`, which re-enters planning for the project's core per its
"Per-core intake" entry, without re-running planning from scratch and
without disturbing anything already built.

Where the contradiction means the request is a different project rather
than an extension of this one, say so plainly instead of routing. That
artifact is never rewritten to accommodate new scope.

If it does not hold, move on to Change-work.

### Change-work

Either condition puts the request here:

- It reaches more than one of the core's layers.
- It introduces a file, module, or capability that does not exist yet.

Where the core has a re-entry route, send the request through
`planner`'s Re-entry routing: the "New scope" line in the core's entry
under "Per-core intake" names who adds the intents. Where it names none,
on `copywriting` start a new first run of its loop, and elsewhere
run `hedgehog intent add` then `hedgehog plan` yourself — without the
plan step nothing is claimable — and on a finished build, enter the
Correction Protocol's **Post-build entry** in `hedgehog-orchestrating`.
Then the installed core's own loop runs, unchanged. Nothing about that
path changes because this gate ran.

### Tweak

Both conditions hold:

- Every file it touches is inside one layer's `scope` globs — one
  layer, not two.
- Every file it touches already exists.

Then, in this session, with no subagent dispatched:

1. Read the code it touches. Not a summary of it.
2. Make the smallest correct edit.
3. Run that layer's own `verify` command from `hedgehog core show`, at the depth
   the next section states.
4. Commit as one conventional commit, in the format the
   `conventional-commits` skill states, with the subject style from the
   layer's `commit` field in `hedgehog core show`.

No `hedgehog intent add`, no `hedgehog plan`, no `hedgehog claim`, no
subagent. Nothing is written to the build graph.

### Tweak is the default under ambiguity

When the conditions do not clearly place a request above the tweak line,
it takes the tweak exit. A gate that escalates when unsure prices every
change at its worst case, which is the failure this gate exists to
avoid.

An escalation the tweak reveals is cheap: a tweak that turns out to
touch a second layer or need a file that does not exist stops there and
re-enters this gate at the change-work exit, having cost one read.

## Test and review depth on the tweak exit

A tweak inherits the test and review bar of the layer it lands in.

- A layer whose `verify_radius` equals its `scope`: run the layer's
  `verify` command. No new tests, and no `reviewer` pass beyond the
  review points the core's loop names for that layer.
- A layer with a wider `verify_radius`, or `exclusive: true`: the same
  real test bar and `reviewer` pass that layer gets in the loop.

That is the loop's own rule, stated in full under "Test-depth and review
rule" in `hedgehog-orchestrating`, applied to a layer instead of a
compiled task. `verify_radius` and `exclusive` are in `hedgehog core
show`, so both are readable on a path that compiles no task.

**A tweak landing in a wide-radius or exclusive layer is a signal.**
Integration layers are where behavior gets proven, so a change reaching
one is rarely as small as it looked when it was asked for. Re-check that
the tweak exit was the right exit. Do not bolt the loop's ceremony onto
the tweak path instead.

**The floor does not move.** A tweak to code with no tests does not get
to leave it that way where the layer's own bar says otherwise.

## Hard rules

- Never take the tweak exit on a file that does not exist yet. A new
  file is change-work by condition, whatever its size.
- Never widen a layer's `scope` to make a change fit the tweak exit.
  A change that needs a wider scope is change-work.
- Never commit a tweak whose layer `verify` command fails. A failing
  gate means the change is not done.
- Never batch two unrelated tweaks into one commit.
- Never rewrite the locked planning artifact to accommodate new scope —
  that is the re-plan exit's decision, and its answer may be that this
  is a different project.
