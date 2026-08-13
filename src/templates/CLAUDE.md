<!--
  Hedgehog project CLAUDE.md template.

  This file is copied into a consuming project's repo root at install
  time, with the core-section marker below filled in from this
  project's chosen core's own CLAUDE.core.<name>.md (src/templates/).
  Placeholders wrapped in {{ }} are filled in once, at planning intake,
  by the `planner` agent (or by hand). Everything outside the
  placeholders is a constant of the Hedgehog discipline and should be
  left as-is.

  Delete this comment block after the placeholders are filled in.
-->

# {{PROJECT_NAME}}

{{PROJECT_SUMMARY — 2–4 sentences the `planner` writes at planning
intake: what this project is, who it's for, and what it does. State
current intent, not history. Keep it tight — the full product narrative
lives in this core's own planning-intake output and the build graph, not
here.}}

This project is built with **Hedgehog**: a one-step-at-a-time build
discipline. The rules below aren't project preferences — they're how the
build stays mechanically correct. Follow them exactly.

## First message in a fresh install

If `{{PROJECT_SUMMARY}}` above is still an unfilled placeholder, this is a
brand-new install and nothing has been built yet. Open with something
short and warm — 🦔 plus one line asking what the user wants to build —
then follow `planner` in this thread, not as a subagent dispatch —
Phase 0's BMAD elicitation is a live, multi-turn conversation the user
needs a direct channel for. Read `planner.md` and run it here through
Confirm & Lock and the `bootstrap` handoff; that handoff and everything
after it delegates normally. Don't re-explain the discipline or
summarize this file; the greeting is one line, not a tour. Skip this
entirely once the placeholder is filled
in — every later session starts with `hedgehog status`, not a greeting.

## How to work here

The build is a loop of small, gated, committed steps. You never hold the
whole plan in context — the plan lives in the structure:

- **The build graph** (`.hedgehog/hedgehog.db`) is the live source of
  truth for what's next. Query it via `hedgehog status`/`hedgehog ready`
  at the start of every session — never re-derive state from prose.
- **The commit log** is the record of what's built and why. Conventional
  commits are how progress is read, not a conversation summary.
- **The architecture is fixed and opinionated for this project's core**
  — the same on every Hedgehog project running that core. Where a piece
  lives, what it may depend on, the build order: all of it is inferable
  from this file and the skills *without reading a line of code*. You
  don't discover the patterns; you already know them.
- **The codebase carries the project-specific instances** — what's
  actually been built, what a given piece's shape is, what's already
  wired. That, you re-read from the code when you need it, rather than
  remembering it.

Because state lives in those places and not in the conversation, a fresh
context loses nothing: the architecture is known a priori, and the
project's specifics are re-read on demand. Use that (see **Managing
context** below).

{{CORE_SECTION}}

## Consuming the graph

`.hedgehog/hedgehog.db` is the source of truth for what's next — never
re-derive build state from prose. To work from it:

1. Run `hedgehog claim --count N --owner <owner>`. It's atomic and
   lease-based, and returns up to N tasks (each with its own full
   STATUS/INTENT/RELEVANT RULES/INHERITED DEBT/WHY NOW/BLOCKED
   DOWNSTREAM/ALLOWED SCOPE/VERIFICATION packet) that the
   scheduler has already verified are safe to run together right now —
   scope and verify-radius disjoint. `--count` is a maximum, not a
   promise: a call may return fewer than N, or zero. `hedgehog ready` is
   a read-only preview of the claimable/held-back split (and why a task
   is held back — conflict with another claimable task, or exclusivity)
   before you claim.
2. Delegate each claimed packet to this core's loop skill (named in the
   section above), one dispatch per packet, running concurrently.
3. As each agent reports its packet done, run `hedgehog verify
   <task-id> --owner <owner>` **serially** — one at a time, even though
   the building happened concurrently, because verify writes git commits
   and those must land one at a time. It checks the touched files
   against the packet's ALLOWED SCOPE, runs the verification command,
   and on a pass writes the commit and unlocks whatever the task was
   blocking. An agent reporting success never moves the task — only a
   passing `hedgehog verify` exit code does.

`hedgehog claim` hands out only tasks safe to run together. Never run
two tasks it didn't hand you together.

The packet's **INTENT** block names the goal and outcome of the *whole*
intent, not just this layer. A layer's own verify command runs the tests
that layer wrote, so it measures internal consistency and never coverage
of what was asked — a layer that builds half the intent and tests that
half exhaustively is green. Build the layer's share of the goal, and say
so when the packet doesn't account for something the goal asks for.
When `hedgehog verify` closes the **last** layer of an intent it prints
that goal and outcome back as an **INTENT CHECK**: read the built work
against it there, because nothing else in the build does.

A layer that discovers a limitation the next layer has to compensate for
records it with `hedgehog debt add <task-id> "<note>"` — it lands in the
**INHERITED DEBT** section of every packet that depends on that task. A
comment in a source file is not a mechanism; nothing reads it.

`planner` owns writing intents (`hedgehog intent add`) at planning
intake; `hedgehog plan` compiles them into the task graph the loop
consumes. Nothing checks a box — there is no checklist, only queryable
state.

**When the build is done:** once `hedgehog status` shows every task
`complete` and `hedgehog boundary` exits 0 (see **Managing context**
below — it checks nothing-in-flight, a clean tree, and a closed intent
together), the build session is complete. The permanent record is the committed
intents (`.hedgehog/intents/*.json`), the friction log
(`.hedgehog/friction/*.md`), the core definition (root `core.yaml` for a
shipped core, `.hedgehog/core.yaml` for an authored one), and the git
commit history itself — not the database. `.hedgehog/hedgehog.db` is gitignored: a
derived index, rebuildable at any time via `hedgehog db rebuild`, which
replays those committed sources against git history. That rebuild also
runs automatically on a fresh clone when the DB is missing but
`.hedgehog/intents/` exists. That's what makes every later session
cheap.

A completed build is **extendable, not sealed**. Offer the user a
fresh-context handoff, and name both ways forward:

- **Adjustments to what's built** → the `tweaker` agent, from a *new*
  chat window, not a subagent call inside this one — this session's
  context has been building the whole project and is exactly what
  "clearing context now costs nothing" (above) means to discard. Tell
  the user plainly: close this chat window and open a new one, then
  paste this to start it:

  > The build for {{PROJECT_NAME}} is complete. Use the tweaker agent:
  > first review the friction log and ask me for feedback on the build,
  > then take my tweak requests one at a time.

  In the new window, `tweaker` starts clean, once reviews the friction
  log (`hedgehog friction list`) for possible discipline-improvement
  issues and separately asks the user directly for feedback on the
  build, filing each real pattern or piece of feedback as its own GitHub
  issue against the Hedgehog repo itself, never this project's repo
  (friction as `bug`/`help wanted`, feedback as `suggestion`, each only
  after showing the exact content and getting explicit approval), then
  takes any tweak requests one at a time.
- **New scope** — a new module or feature, anything beyond adjusting what
  exists → on a core with a module axis, the `planner` agent, which runs
  `hedgehog-planning-intake`'s **Re-entry pass**. It reads the existing
  planning archive as context and elicits only what's new, then adds
  intents and runs `hedgehog plan`. This is append-only: `plan` skips
  intents already compiled, so every `complete` task keeps its status and
  its commits, and `hedgehog claim` resumes at the first tasks of the new
  work. Planning is not re-run from scratch, and the workspace is not
  re-scaffolded. (This core's own section above states where new scope
  goes if this core has no module axis to add an intent to.)

If a request turns out to be structural rather than either of those —
something already built is wrong at its source — that's the Correction
Protocol's post-build entry, in this core's own loop skill.

## Managing context

Hedgehog is designed so the conversation is disposable. Keep the working
context small:

- **Clear context at natural boundaries** — a module's Phase A, a
  landing page section, whatever this core's own unit boundary is — once
  that unit is done and committed. Ask `hedgehog boundary` rather than
  judging it: it exits 0 only when all three of nothing-in-flight, a
  clean working tree, and a last closed task that completed its intent
  hold, and names which one failed otherwise. Clear the conversation and
  start fresh, then run `hedgehog status`/`hedgehog claim` and continue.
  Nothing is lost, because the build graph, commits, and code hold all
  the state. Prefer this over letting one session accumulate the entire
  project.
- **`hedgehog quiesce` and `hedgehog boundary` answer different
  questions.** `quiesce` reports whether anything is still in flight —
  necessary before clearing (clearing while a lease is outstanding
  orphans that lease until it expires), but not sufficient: a graph can
  be perfectly settled halfway through an intent, with a dirty working
  tree. `boundary` is the whole question — is this a moment to throw the
  conversation away — and it includes the `quiesce` check as its first
  condition. Use `quiesce` when you're waiting for dispatched work to
  land (the Correction Protocol), `boundary` when you're deciding whether
  to clear.
- **A cleared or new session recovers by running `hedgehog status` and
  reading the commit log**, never by needing the prior conversation.
  `hedgehog boundary --handoff` prints that recovery block directly —
  where the build is, what's next and why, what's in flight, what's
  blocked — derived from the graph, so no session hands a summary to the
  next one.
- **Delegate heavy work to agents.** Scaffolding and every build step
  run in their own isolated context, so work doesn't pile up in the
  main thread. Planning intake's BMAD Phase 0 is the exception — see
  **First message in a fresh install** above — and stays here through
  Confirm & Lock; the mining, `bootstrap`, and per-module steps after it
  delegate as usual.
- **Don't paste large context back in.** If you find yourself
  re-explaining the architecture, stop — it's fixed and stated in this
  file's core section, not something to reconstruct. If you need a
  project specific, read it from the code. That's the self-documenting
  design working as intended.

{{HOST_DISPATCH}}
