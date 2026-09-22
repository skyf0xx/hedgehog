<!-- hedgehog:bootstrap-only start -->
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
<!-- hedgehog:bootstrap-only end -->

# {{PROJECT_NAME}}

{{PROJECT_SUMMARY — 2–4 sentences the `planner` writes at planning
intake: what this project is, who it's for, and what it does. State
current intent, not history. Keep it tight — the full product narrative
lives in this core's own planning-intake output and the build graph, not
here.}}

This project is built with **Hedgehog**: a one-step-at-a-time build
discipline. The rules below aren't project preferences — they're how the
build stays mechanically correct. Follow them exactly.

<!-- hedgehog:bootstrap-only start -->
## First message in a fresh install

If `{{PROJECT_SUMMARY}}` above is still an unfilled placeholder, this is a
brand-new install and nothing has been built yet. Open with something
short and warm — 🦔 plus one line asking what the user wants to build —
then follow `planner` in this thread, not as a subagent dispatch —
Phase 0's BMAD elicitation is a live, multi-turn conversation the user
needs a direct channel for. Read `planner.md` fresh off disk (this
install just wrote it, in this session — don't rely on a prior read or
prior-project memory of what it says) and run it here through Confirm &
Lock and the `bootstrap` handoff. This same rule holds at every later
handoff to a newly-installed agent or skill in this session: read its
file, don't assume its content.

The build continues in this session — nothing here needs a restart. Hosts
differ in whether they pick up agents written mid-session, so prefer
reading an agent's file from `.claude/agents/` and following it inline;
each one is self-contained, and that path works everywhere. Reading also
avoids the quiet failure of dispatch by name, where `planner` or
`reviewer` resolves to the user's own unrelated global agent and runs a
different discipline with no symptom. If a dispatch does error with a
list of available agents that omits Hedgehog's, that is the same case —
read the file and carry on.

Don't re-explain the discipline or summarize this file; the greeting is
one line, not a tour. Skip this entirely once the placeholder is filled
in — every later session starts with `hedgehog status`, not a greeting.
<!-- hedgehog:bootstrap-only end -->

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
project's specifics are re-read on demand. The `hedgehog-orchestrating`
skill (see **Running the build** below) is what uses that.

**Use only the skills and agents this repo provides**, including its
vendored BMAD shelf — never a general-purpose build-tool skill pack
(e.g. "superpowers") or another project's agent set. Hedgehog's
enforcement (scope boundaries, no self-certification, the commit-gated
loop) is what a generic skill pack has no notion of, and running one
alongside Hedgehog's own skills produces work that bypasses the very
discipline this file describes.

**Build through the loop, including when the work looks too small to need
it.** A task that seems like a quick edit is not a reason to skip the
graph, the step sequence, or the gate — scope grows, and the shortcut is
what turns a small change into debt the next step has to work around.
Don't propose going around the discipline to save a step, and don't treat
a user's impatience as license to: say what the loop's next step is and
take it. Where a rule genuinely conflicts with what the user is asking
for, name the conflict and let them decide — never resolve it by quietly
taking the faster path.

{{CORE_SECTION}}

## Running the build

The build graph is the source of truth for what's next — never re-derive
build state from prose. The `hedgehog-orchestrating` skill owns the claim →
dispatch → verify cycle, the intent check, debt and decision recording, the
context boundaries to clear at, and the post-build handoff. Read it at the
start of every session and follow it.

{{HOST_DISPATCH}}
