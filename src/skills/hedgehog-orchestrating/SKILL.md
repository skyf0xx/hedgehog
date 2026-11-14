---
name: hedgehog-orchestrating
description: Use at the start of any session on a project with a build graph (`.hedgehog/hedgehog.db`), and again at every claim/dispatch/verify cycle within it. Owns the core-neutral build loop every core shares — claiming task packets, dispatching each to the agent the core's loop skill names, `hedgehog verify` as the commit gate, debt and decisions, the intent check, the test-depth and review rule, the Friction log, the Correction Protocol and its Post-build entry, the Stop Condition, the graph exits, and when to clear context. Not for a build agent handed an already-claimed packet — that agent never claims, dispatches, or verifies.
---

# Orchestrating the build

`.hedgehog/hedgehog.db` is the source of truth for what's next and what's
built. Read state from `hedgehog status` — counts by status, what's
ready, what's in flight, NEEDS ATTENTION, DRIFT — and `hedgehog why
<path>` for one file's provenance. Never infer which layer or phase is
built from commit messages or prose.

## Who owns what

- **This skill** owns the cycle below — claim, dispatch, verify — and
  every section after it. A core's loop skill references these sections
  by name.
- **The core's loop skill** (named in the project's core section)
  supplies what is core-specific: which agent builds which layer, the
  conventions inside a layer, the review checklist, and any
  core-specific addition to a section here. `hedgehog core show` prints
  the core's layers, each with its scope, verify, and commit.
- **A build agent** builds one packet it was handed and reports. It never
  claims, verifies, commits, or corrects across layers.

Where a core's loop skill restates one of these sections, this skill's
version holds, plus any core-specific addition. Claim only at step 1
below: when a core loop's own step says to run `hedgehog claim` while
this session holds packets, skip it and go to that loop's dispatch step.
Claim and verify with the same owner; where the core's loop names a
fixed owner, use it.

## The cycle

1. **Claim.** `hedgehog claim --count N --owner <owner>`, where `<owner>`
   is a stable id for this session. It is atomic and lease-based, and
   returns up to N packets the scheduler already cleared as safe to run
   together (scope and verify radius disjoint). `--count` is a maximum:
   a call may return fewer, or zero. `hedgehog ready` previews the
   claimable/held-back split and why each holdback. A
   `blocked` task anywhere in the graph makes `claim --count` refuse with
   a non-zero exit naming it; a targeted `hedgehog claim <task-id>
   --owner <owner>` is exempt. Never run two tasks together that one
   claim did not hand out together.
2. **Dispatch** each packet to the agent the core's loop skill names for
   its layer, all packets concurrently, each with the full packet.
   Unless the core's loop skill says otherwise, build a packet inline
   only when the packet alone shows one of these: ALLOWED SCOPE is a few
   files you can read without bloating this context; RELEVANT RULES show
   the layer is plainly untouched by this intent; or the change is small
   and mechanical (a rename, an import fix, a one-line registration).
   Switch to a dispatch the moment that stops being true. Either way the
   same gate applies at step 4, and a no-op is reported per the packet's
   HONESTY rules, never assumed. An agent reported as not found right
   after `init` or `update` installed it is covered by the instructions
   file's "Delegating on this host" section.
3. **Build and report.** Whoever built the packet runs its VERIFICATION
   command as a sanity check, then reports. A report moves nothing.
4. **Verify, serially.** As each report arrives, run `hedgehog verify
   <task-id> --owner <owner>` with the owner that claimed it — one at a
   time, because each pass writes a commit. It checks touched files
   against ALLOWED SCOPE, runs the verify command, and on a pass commits
   and unlocks dependents. A first-time task with nothing changed in its
   scope closes as a no-op without running the command; `exclusive`
   layers such as a join, layers with a `verify_radius`, and reopened
   tasks always run it. Only a passing verify moves a task. On a fail
   the task goes `blocked` (`scope_violation` or `verification_failed`):
   fix the work, `hedgehog retry <task-id>`, claim it by id, verify
   again. Never hand-commit around a block.
5. **Repeat** from step 1.

A long build keeps its lease with `hedgehog renew <task-id> --owner
<owner>`; an expired lease blocks the task as `lease_expired`. Statuses
are `planned`, `ready`, `building`, `verifying`, `complete`, `blocked`.

### What the packet carries forward

- **INTENT** is the goal and outcome of the whole intent, not this
  layer's. A layer's verify checks what that layer wrote, so it
  measures consistency, never coverage of what was asked. Build the
  layer's share of the goal, and say so when the packet leaves part of
  the goal unaccounted for. When verify closes an intent's **last**
  layer it prints an **INTENT CHECK**: read the built work against it
  there, because nothing else in the build does.
- **Debt** — a limitation the next layer has to compensate for: `hedgehog
  debt add <task-id> "<note>"`. It lands in INHERITED DEBT of every
  dependent packet.
- **Decisions** — a choice a dependent layer should follow rather than
  reinvent (a pattern, a library, a trade-off): `hedgehog decision add
  <task-id> "<note>"`, landing in INHERITED DECISIONS.

## Test-depth and review rule

**Test depth follows verify radius. Review follows exclusivity.** Read
both off the layer's fields in `core.yaml`:

- A layer whose `verify_radius` equals its `scope` (the default) is
  internally consistent only. Its verify command has to check something
  real (where it runs tests, enough tests to mean something), and it
  gets no `reviewer` pass from this rule.
- A layer with a wider `verify_radius`, or `exclusive: true`, is a join
  or integration point. The real test bar and the `reviewer` pass belong
  there.

The floor never moves: a verify command that checks nothing certifies
nothing. The rule applies to a layer as declared, so a tweak with no
compiled task inherits it from the layer it lands in. A core's loop
skill may name its own review points; those add to this rule.

## Friction log

Log real friction as it happens, with `hedgehog friction add "<note>"
[--task <task-id>]`: an agent's instructions were unclear, a redline had
to be issued twice for the same gap, the user corrected the same kind of
mistake twice, or user feedback implied an earlier step missed
something. Put what was tried, what went wrong or was implied, and the
commit or message it traces to in the note; pass `--task` when it traces
to one task. It is a log, not a todo list: log and keep moving.

The `tweaker` agent reviews the log once a batch of open friction has
built up; `tweaker` owns that threshold and closes each reviewed row
with `hedgehog friction resolve`. `hedgehog friction list` shows the rows
still open. The core's loop skill may name the friction that matters
most on that core.

**Commit the records before a boundary.** `friction add`, `debt add`,
`decision add`, and a no-op verify write records under
`.hedgehog/friction/`, `.hedgehog/notes/`, and `.hedgehog/noop/` without
committing them, no layer's commit picks them up, and `hedgehog
boundary` counts them as a dirty tree. Commit them on their own (`chore:
build graph records`) before running `hedgehog boundary`.

## Correction Protocol

When a downstream layer reveals that an upstream layer was wrong:

1. **Quiesce.** Dispatch nothing new. Let in-flight tasks finish and
   verify normally; do not stop running agents. Release the task that
   revealed the fault and anything claimed but not started (`hedgehog
   release <task-id> --owner <owner>`). Go on when `hedgehog quiesce`
   exits 0.
2. **Reopen.** `hedgehog reopen <task-id> --confirm` returns the wrong
   task and every `complete` task downstream of it to `planned`, and
   names any downstream task it left alone because it was not complete.
   (`retry` works only on a `blocked` task.)
3. **Patch at the source.** Claim the reopened task by id, check what
   references the symbol you are changing (the LSP tool's
   findReferences/incomingCalls, where the language has one), patch it
   in place, and verify. If the layer produces a built output that
   downstream layers or a running dev process consume (a compiled
   package, a generated client, a bundle), rebuild it before verifying
   anything downstream.
4. **Fast-forward.** Each reopened dependent goes back through claim and
   verify in dependency order. Verify runs each one's verify command; a
   dependent that needed a change commits it, and an unchanged one
   closes with no commit. The commit messages are the explanation.
5. **Review.** Dispatch `reviewer` on the patch and its dependents
   together.
6. **Resume.** Claim the task that revealed the fault again by id
   (`hedgehog claim <task-id> --owner <owner>`), or `hedgehog retry
   <task-id>` first if it went `blocked`; otherwise the next `claim
   --count` refuses. Then continue at step 1 of the cycle.

The orchestrating session runs this protocol and owns its commits. Use
`conventional-commits` when a correction made in one working-tree pass
needs splitting into per-layer commits.

When the **layer sequence itself** is wrong (a layer missing or
misplaced, a scope glob that never fits), stop and hand it to `planner`
(on `adopted`, `hedgehog-adopt`). After `core.yaml` changes, `hedgehog
plan --recompile` rewrites not-started tasks (`--dry-run` previews it);
every task it refuses is fixed forward through this protocol. Never
patch a task row in SQLite: `hedgehog db rebuild` drops the patch.

**Narrow out-of-scope fix.** A real bug exposed mid-layer, or a small
addition another intent structurally needs (a registration, a one-line
wiring), goes in directly as its own commit, separate from the current
task's commit, when it is small, obviously correct, and passes the
affected layer's verify command. It is never folded into the task's
commit and never dropped. The moment it touches more than a couple of
lines, its correctness is not obvious, or it changes untested behavior,
run the full protocol.

### Post-build entry

The protocol also runs after the Stop Condition, when the `tweaker`
agent finds something structural wrong rather than small. The patch at
the source and one commit per layer hold; the ends differ:

- Nothing is in flight, so there is no quiesce. Start by naming which
  committed layer was wrong and what revealed it.
- Every touched task stays `complete`: fix forward in new commits,
  without `reopen`. Verify each patched layer by running its verify
  command (`hedgehog core show`) directly.
- There is no loop to resume. Log the correction with `hedgehog
  friction add`, then return to the `tweaker` session.

## Stop Condition

A build session ends when either holds:

- `hedgehog status` shows every task `complete` and `hedgehog boundary`
  exits 0 (nothing in flight, clean tree, last closed task completed its
  intent). All tasks `complete` is not enough on its own.
- Scope is ambiguous enough that going on means guessing: ask one
  question and wait.

A core's loop skill may move, replace, or remove this stop and the
handoff below.

On a real completion, tell the user the build is complete and that
clearing context costs nothing: the committed records under
`.hedgehog/`, the core definition, and the git history hold everything,
and `hedgehog db rebuild` re-derives the gitignored graph from them. A
completed build is extendable, not sealed; name both ways forward:

- **Adjustments to what's built** → the `tweaker` agent, in a new chat
  window, not a subagent here: this context is what clearing discards.
  Tell the user to close this window, open a new one, and paste:

  > The build is complete. Use the tweaker agent: first review the
  > friction log and ask me for feedback on the build, then take my
  > tweak requests one at a time.

- **New scope** → the `planner` agent's Re-entry pass
  (`hedgehog-planning-intake`). It adds intents and runs `hedgehog
  plan`, which skips compiled intents, so finished work keeps its status
  and commits. On a core with no module axis, the core's section says
  where new scope goes.

Something already built that is wrong at its source goes to the
Post-build entry. Make no tweaks or new plans in this context.

## Graph exits

| Situation | Command |
|---|---|
| Look at any task's packet, at any status | `hedgehog show <task-id>` |
| Which task wrote a file, and why | `hedgehog why <path>` |
| Stop a claimed task cleanly before finishing | `hedgehog release <task-id> --owner <owner>` |
| Still building past the lease window | `hedgehog renew <task-id> --owner <owner> [--minutes <n>]` |
| A blocked task is fixed | `hedgehog retry <task-id>`, then claim it by id |
| A `complete` layer was wrong (Correction Protocol) | `hedgehog reopen <task-id> --confirm` |
| An intent planned into its own worktree has all tasks complete there | `hedgehog merge <intent-id>`, run from trunk |
| An intent planned into its own worktree will never finish | `hedgehog abandon <intent-id> --reason "<why>"`, run from trunk |
| A small intent's fix is already committed, below the per-layer loop | `hedgehog fast-path <intent-id> --reason "<why>" --verify "<command>"` |
| Commits landed outside `hedgehog verify` | `hedgehog reconcile` (proposes), `reconcile confirm <task-id> --reason "<why>"`, `reconcile list` |
| Debt was paid off by a later layer | `hedgehog debt resolve <debt-id> --reason "<why>"` |
| A friction row was addressed | `hedgehog friction resolve <friction-id> --reason "<why>"` |
| Read recorded decisions | `hedgehog decision list [<task-id>]` |

## Managing context

- **Clear context at the core's unit boundary** once that unit is done
  and committed. Ask `hedgehog boundary` rather than judging: it exits 0
  only when nothing is in flight, the tree is clean, and the last closed
  task completed its intent, and names what failed otherwise.
  `hedgehog quiesce` checks only the first; use it while waiting out a
  correction, and `boundary` when deciding whether to clear.
- **A new session recovers from `hedgehog boundary --handoff`** — where
  the build is, what's next and why, what's in flight, what's blocked —
  never from a summary of the prior conversation.
- **Delegate heavy work to agents**, so it runs in its own context.
- **Don't paste large context back in.** The architecture is fixed in
  the project's core section; read project specifics from the code.
