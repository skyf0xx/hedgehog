---
name: hedgehog-landing-loop
description: Use for every unit of work on the landing-page core, from planning intake through the final build phase — the Chain Method's brief → feeling → tokens/element → sequence → artifact pipeline, gated by `hedgehog verify` and committed one phase at a time. Triggers on "next step", "next phase", "what's next", or the start of any work session on a bootstrapped landing-page project. Also covers this core's own planning intake and Correction Protocol.
---

# Hedgehog Landing Loop

The operating loop for a bootstrapped `landing-page` project: `hedgehog
claim --owner <owner> --count <n>` emits the packet for one ready phase
(this core's chain is linear, so `--count N` always returns 1), run it
through its owning agent, `hedgehog verify` gates and commits it. The
build graph (`.hedgehog/hedgehog.db`) is the live list — query it via
`hedgehog status`/`hedgehog ready`, never re-derive state from prose. The
five compiled phases (`src/golden-cores/landing-page/core.yaml`, already
the source of truth) are the degenerate one-module case of the layer
graph: one task per phase, each depending on the one before it.

This is the **Chain Method**: a pipeline where every visual choice traces
back to a reason. No agent may introduce a choice that doesn't originate
in the previous agent's output — that discipline is what this skill
enforces mechanically, the same role Nx module boundaries play for
`full-stack-app`.

## Planning intake (Phase 0, before any build phase)

Run once, before `bootstrap` scaffolds the workspace. Opens with
`hedgehog-planning-intake`'s Phase 0 — the same vendored BMAD-METHOD
shelf `full-stack-app` runs, in the same full sequence, archived to the
same `.hedgehog/BMAD/` layout. After that Phase 0 completes, this
section does its own mining — a one-paragraph subject statement, the
landing-page counterpart to `hedgehog-planning-intake`'s own Phase 1
(domain modules and an Add-ons decision on full-stack-app). That mined
draft becomes the first draft of `.hedgehog/chain/00-brief.md`, shown
back at Confirm & Lock for the user to accept or correct.

1. **Run `hedgehog-planning-intake`'s Phase 0 in full**: state the BMAD
   attribution it states, then run `bmad-brainstorming`,
   `bmad-product-brief`, `bmad-prfaq`, `bmad-prd`, `bmad-ux`,
   `bmad-deep-recon`, archived to `.hedgehog/BMAD/` with the fixed layout
   and `00-manifest.md` attribution header that skill's Phase 0 defines.
   `.hedgehog/BMAD/` is archival and immutable once written, same as
   `full-stack-app` — nothing in this core's day-to-day loop reads it
   live after this step mines it once.
2. **Mine a draft subject statement** from `.hedgehog/BMAD/`: the
   concrete subject (what is this actually selling/announcing/showing),
   the audience, and the page's single job, sourced from the brief and
   PR-FAQ (a landing page's brief and PR-FAQ are the closest BMAD
   artifacts to a subject statement — the PRD's Glossary and deep-recon
   output are read for supporting color, not required to resolve a
   one-page subject/audience/job). Where BMAD's material leaves any of
   the three genuinely unresolved, ask directly — don't proceed on
   vagueness, and don't invent an audience or job that wasn't stated,
   mined, or confirmed.
3. **Write `.hedgehog/chain/00-brief.md`** — the mined subject statement,
   one paragraph, plus the audience and single job named explicitly.
   This is the root every downstream phase's traceability audit walks
   back to; it draws from BMAD's archive but is its own file, in this
   core's own `.hedgehog/chain/` layout, not a pointer into
   `.hedgehog/BMAD/`.
4. **Confirm & Lock** — show the mined subject statement, audience, and
   job back in plain terms, alongside which BMAD skills ran and where
   their output lives (`.hedgehog/BMAD/`), before writing anything to the
   build graph. State plainly what happens on confirmation: *"This locks
   in the brief, adds the `landing` intent to the build graph
   (`hedgehog intent add`), compiles it into the five-phase chain
   (`hedgehog plan`), commits (`chore(planning): intake`), and hands off
   to `bootstrap` to scaffold the Astro workspace. The Strategist phase
   starts once that closes. Anything wrong or missing — say so now."*
   Wait for explicit go-ahead — a revision here is just another mining
   pass against the same BMAD archive, not a Correction Protocol entry,
   since nothing downstream exists yet.
5. **Add the intent and compile the graph**: `hedgehog intent add --id
   landing --goal "<subject statement>" --outcome "<audience + single
   job>"` — one call, no `--rule`/`--depends-on` needed; landing-page has
   no module axis, so this single intent is what `hedgehog plan` compiles
   against `src/golden-cores/landing-page/core.yaml` into the five phase
   tasks. Run `hedgehog plan` next, then `hedgehog status` to show the
   compiled chain.
6. **Commit planning intake's output as one commit**,
   `chore(planning): intake` — the committed intent
   (`.hedgehog/intents/landing.json`), `.hedgehog/BMAD/`,
   `.hedgehog/chain/00-brief.md`, and root `CLAUDE.md`'s filled
   placeholders. `.hedgehog/hedgehog.db` is gitignored and derived —
   `hedgehog plan` compiles it from the committed intent, and `hedgehog db
   rebuild` re-derives it from that same intent plus git history.
7. **Hand off to `bootstrap`** once the commit lands.

`planner` owns this section; see that agent for when it runs.

## The Chain Method phases

Every phase's input is the prior phase's output, in this exact order — no
agent works from anything but what was actually handed to it. Steps 4a
(inside `landing-systems`) and 4c (inside `landing-strategist`) are the
only parallel-input point in the chain, both reading the same upstream
artifact; everything else is strictly sequential.

This table's 12 rows are the fine-grained, per-agent-dispatch view. The
compiled build graph (`src/golden-cores/landing-page/core.yaml`) has only
5 layers — `brief`/`feeling`/`tokens`/`sequence`/`artifact` — because it's
the coarser, one-task-per-commit view: rows 1–4 compile into one `feeling`
task, 5–7 into one `tokens` task, 8–10 into one `sequence` task, 11–12
into one `artifact` task. These are intentionally not 1:1; don't "fix"
either one to match the other's granularity — see The Loop below for how
one delegated phase relates to one compiled task.

| # | Phase | Agent | Produces | Commit |
|---|---|---|---|---|
| 1 | Strategist | `landing-strategist` | Subject/audience/job statement (from planning intake — restated here as this phase's formal output) | `feat(landing): strategy` |
| 2 | Brand Anthropologist | `landing-strategist` | 3–5 adjective pairs (each with a named opposite) | bundled into `feat(landing): strategy` |
| 3 | Psychologist | `landing-strategist` | Adjectives sorted visceral / behavioral / reflective | bundled into `feat(landing): strategy` |
| 4 | Perfumer | `landing-strategist` | Top/heart/base note timing per adjective, the page's peak moment, the ending treatment | bundled into `feat(landing): strategy` |
| 5 | Ingredient Director + Copywriter | `landing-systems` | Dial table (color/type/form/space/motion) + voice spec, run against the same sorted-adjectives input | `feat(landing): systems` |
| 6 | Systems Designer | `landing-systems` | The token system (hex values, type roles, spacing unit, easing family, copy voice, with note timing attached) | bundled into `feat(landing): systems` |
| 7 | Signature Element | `landing-systems` | Signature element (source, persistence, continuity, scale range, literalness) | bundled into `feat(landing): systems` |
| 8 | Sequencer | `landing-sequencer` | Per-section transition type, weight, spacing, beat structure | `feat(landing): sequence` |
| 9 | Headline | `landing-headline-writer` | The headline plus 2 backups, from 3 distinct rhetorical mechanisms, reviewed and locked by the user | `feat(landing): headline` |
| 10 | Copywriter (one invocation per section) | `landing-copywriter` | One section's body text and CTA copy per invocation, to the fixed paragraph algorithm, reviewed and locked by the user before the next section starts | `feat(landing): copy` (one commit once every section locks, or extended per section — never split across an unlocked section) |
| 11 | Critic + Usability Auditor | `landing-critic` | Redlines, or a pass — reconciled traceability/distinctiveness + usability audit | `feat(landing): audit` (no commit if redlined — see Correction Protocol) |
| 12 | Builder | `landing-builder` | The built page, in Astro | `feat(landing): build` |

Phases 1 through 4 are one agent's context (`landing-strategist`)
because they're one continuous judgment call — subject into feeling into
timing — not separable artifacts with different tool footprints. Same
reasoning collapses 5–7 into `landing-systems` (everything that becomes
a Tailwind token or a copy rule) and 11's reconciliation into a single
`landing-critic` pass. The headline is its own phase (9), one agent, one
artifact, one review checkpoint, because it's the single highest-leverage
line on the page — every section beneath it either delivers on its
promise or doesn't, so it locks before any section body is drafted. Copy
(10) is its own phase too, run once per section rather than once for the
whole page, specifically so the user reads and confirms each section's
actual words before the next section is drafted, and before either the
audit or the build runs — see `landing-headline-writer`'s and
`landing-copywriter`'s own files for their writing standards, the
paragraph algorithm, and their self-tests.

## The Loop (every unit of work)

1. **Run `hedgehog claim --owner <owner> --count <n>`.** `<owner>` is
   this session (a stable id — session id or equivalent). It emits the
   task packet for one ready compiled layer (STATUS/WHY NOW/BLOCKED
   DOWNSTREAM/ALLOWED SCOPE/VERIFICATION) — trust it: `hedgehog claim`
   never hands out a layer whose dependency isn't `complete`, so there's
   no separate gate check to run by hand. This core's chain is linear, so
   `--count N` always returns 1 task, never more — see Rules below.
   `hedgehog ready` previews the same decision without claiming anything.
2. **Map the packet's layer to the fine-grained phases it bundles**, per
   the table above (`feeling` = phases 1–4, `tokens` = 5–7, `sequence` =
   8–10, `artifact` = 11–12), and **delegate to that layer's owning
   agent(s)**, passing the full chain so far (every upstream artifact,
   not just the immediately prior one) — an agent that only sees its
   direct input can't verify its own traceability back to the subject
   statement. Within a bundled layer, run its phases in order and in one
   continuous pass: phase 10 (`landing-copywriter`) still runs once per
   section, in `landing-sequencer`'s order, every section reviewed and
   locked before the next starts, all still inside the one `sequence`
   task.

   **Relaying a live user-confirmation checkpoint to a delegated
   subagent.** Phase 1 (Strategist) carries a hard-stop checkpoint per
   Phase Transition Checks below, and a delegated subagent instance has no
   channel for the user to address it directly. The orchestrating session
   relays the confirmation instead, and the relay is sufficient only if it
   quotes the user's actual words with its provenance stated plainly
   (*"Relaying the user's own confirmation, verbatim — user said:
   '\<exact words\>'"*) rather than asserting the outcome ("the user
   approved"). This trusts the orchestrator's honesty about provenance,
   the same trust the rest of this discipline already places in it for
   relaying artifacts and task packets.
3. Each agent **runs its own self-test** (see that agent's own file for
   what it checks) before presenting its artifact — necessary, not
   sufficient. This is a sanity check the agent does for itself; it does
   not move the task and the agent does not commit its own work, whether
   run directly or delegated to a subagent instance. `landing-strategist`,
   `landing-systems`, `landing-sequencer`, and `landing-headline-writer`
   carry no Bash tool at all (`capabilities.mjs`), so the commit is always
   the orchestrating session's act via `hedgehog verify`, never the phase
   agent's own.
4. Once every phase inside the packet's layer has been presented and
   locked by the user, **run `hedgehog verify <task-id> --owner
   <owner>`.** It checks the touched files against the packet's ALLOWED
   SCOPE, runs the layer's `VERIFICATION` command, and on a pass writes
   the commit (the exact Conventional Commit message from the table
   above) and unlocks the next layer. On a scope violation or a failing
   check, the task moves to `blocked` with a `blocked_reason` of
   `scope_violation` or `verification_failed`, and nothing downstream
   unlocks — fix it and re-run `hedgehog verify <task-id> --owner
   <owner>`, don't hand-commit around it.
5. **Repeat** — `hedgehog claim --owner <owner> --count <n>` again for
   the following layer.

Each `hedgehog verify` call commits exactly one compiled layer's
artifact; a wrong phase is fixed forward later via the Correction
Protocol.

## Friction log

Same mechanic as `hedgehog-loop`'s Friction log — log real friction (a
phase's instructions unclear, `landing-critic` redlining the same
underlying gap twice, a repeated user correction) via `hedgehog friction
add "<note>" [--task <task-id>]`, `tweaker` reads it at the Stop
Condition.

## Correction Protocol

Same core mechanic as `hedgehog-loop`'s Correction Protocol (stop, patch
the upstream step in place, fast-forward every dependent step as its own
commit, commit messages as the explanation, resume the loop), triggered
most often by `landing-critic` redlining something that doesn't trace
back to the subject statement or matches a known AI-default cluster. Two
differences for this core:

- **Fast-forwarding ripples further.** A token system change (phase 6)
  ripples through the signature element (7), the sequence (8), the
  headline (9, if the voice spec shifted) and every locked section of
  copy (10, re-run per affected section, not the whole phase over again),
  and the build (12) — each its own small commit, in order.
- **Re-run `landing-critic` against the patched chain before resuming** —
  an extra step this core adds, since traceability is what the whole
  chain rests on.

The orchestrating session runs this protocol and owns every commit in it.
A phase agent re-runs its own phase when the patch is to that phase's
artifact, but most of these agents carry no `Bash` tool at all
(`capabilities.mjs`), so the commits are always the session's act — the
same way `hedgehog verify` always is.

Use `conventional-commits` when a correction touches several phases in
one working-tree pass and needs splitting back into per-phase commits.

### Post-build entry

Same shape as `hedgehog-loop`'s Post-build entry — no task to stop, no
loop to resume (return to `tweaker` instead), every touched task stays
`complete` and is fixed forward in new commits. This core routes here for
two distinct reasons: something structural is wrong rather than small
(the voice spec itself rather than one line of copy), or new scope is
genuinely additive but has nowhere else to go — a new section under a
brief that still holds, since this core has no module axis for
`planner`'s Re-entry pass to add an intent to. Either way, the protocol's
"patch" step reads as "add" in the additive case, and re-running
`landing-critic` against the patched chain still holds before handing
back, since traceability is what the whole core rests on.

## Phase Transition Checks

Before `landing-strategist`'s step 2 (Brand Anthropologist) starts,
confirm step 1's subject/audience/job statement has been shown to and
confirmed by the user — not just drafted. This is the cheapest point in
the whole chain to correct the core framing (nothing downstream exists
yet); every phase after it inherits that framing silently, and by the
time copy is reviewed at phases 9–10, a wrong framing means unwinding
several committed phases via the Correction Protocol instead of one free
revision here. If step 1 was run by a delegated `landing-strategist`
subagent instance, the confirmation reaches it as a relay from the
orchestrating session — see The Loop above for the provenance statement
that relay must carry.

Before `landing-copywriter` starts (phase 10), confirm
`landing-headline-writer`'s headline has been presented to and locked by
the user, not just drafted — every section's copy is written against
whichever headline is locked at phase 9, so an unlocked headline means
every section written against it is provisional too.

Before each `landing-copywriter` invocation after the first, confirm the
previous section is locked, not just presented — the next section's
continuity check (no repeated claims, no synonym drift) reads the prior
section's actual locked text, not a draft still awaiting edits.

Before `landing-critic` starts, confirm every section `landing-copywriter`
wrote has been presented to and locked by the user, not just written —
`landing-critic`'s traceability audit reads confirmed copy, not a draft
still awaiting review.

Before `landing-builder` starts, confirm:

- `landing-critic` returned a pass, not a redline — a redlined spec never
  reaches the Builder; it goes back to the phase the redline names.
- `hedgehog status` shows the `sequence` task `complete` (phases 1–11's
  commits have landed).

Before `landing-strategist` starts, confirm planning intake's Confirm &
Lock has held and its commit has landed. If not, stop and ask.

Before the Polish Loop starts, confirm `hedgehog status` shows the
`artifact` task `complete` — `landing-builder`'s initial build has
landed. The Polish Loop never opens against an unbuilt or partially
built page.

## Polish Loop

Once `landing-builder` commits `feat(landing): build`, the compiled
graph is done — `hedgehog status` shows every task `complete` — but the
orchestrating session runs one more uncompiled pass before offering the
Stop Condition's handoff: a bounded loop that polishes the rendered page
for visual and interaction quality independent of the chain's own
traceability concerns. This is not a compiled layer (no `hedgehog claim`
packet, no `hedgehog verify` gate) — it runs the same way the Correction
Protocol's post-build entry does, driven directly by the orchestrating
session, because it operates on the built page after the graph's own
Stop Condition has already been reached.

**Why this is separate from `landing-critic`.** Phase 11 gates whether
the page traces back to the subject statement and clears the usability
formulas, before a single line of Astro exists. The Polish Loop runs
after the page is actually rendered and interactive, catching what only
shows up once it's real: AI-tell visual patterns, dead or uneven gaps,
scan-pattern and interaction friction, and a general taste pass — none
of which `landing-critic` checks and none of which require re-opening
the chain's own artifacts.

All three Polish Loop agents work on their own editorial judgment, not a
fixed checklist derived from the chain's generation-time rules — a
finished page invites critique-and-improve the way a human editor or
designer gives it, which is a different, often sharper instinct than the
constrained judgment calls phases 1–11 make while generating the first
draft from nothing. `landing-executor` in particular has full license
over the rendered page's markup, styling, and copy substance — it can
rewrite a sentence, cut a paragraph, or restructure a section, not just
swap a word — bounded only by the locked stack/token system and by never
touching `.hedgehog/chain/*.md` itself (see that agent's own file for
why: those are the historical record of the first draft's reasoning, not
something a later pass edits to match a rewrite).

1. **`landing-executor`** applies the current iteration's redlines (none,
   on the first pass — the first pass reviews `landing-builder`'s output
   as-is) directly to the built page.
2. **Build and screenshot** — `landing-visual-reviewer` and
   `landing-ux-reviewer` each build and serve the page fresh; don't
   review against a stale render.
3. **Both reviewers run in parallel**, independent of each other:
   `landing-visual-reviewer` for AI-tell patterns, gap/rhythm, and visual
   taste; `landing-ux-reviewer` for scan-pattern, flow/friction, and
   interaction taste. Each returns redlines or clean.
4. **Decide:**
   - Both clean → exit the loop, proceed to the Stop Condition.
   - Either has redlines, and the iteration count is below 10 → commit
     nothing yet, return to step 1 with the combined redlines for
     `landing-executor` to apply as the next iteration.
   - Either has redlines, and 10 iterations have already run → exit the
     loop anyway (the cap is a backstop against unproductive churn, not
     a quality gate) and note in the handoff to `tweaker` that the loop
     hit its cap with redlines still open.
5. **Commit each iteration separately** as `feat(landing): polish
   iteration <n>` (`landing-executor`'s own act — it carries `Bash`
   unlike most phase agents) — one commit per pass through steps 1–3,
   not one squashed commit at the end.

The loop's iteration count resets per Polish Loop run — a later
`tweaker` session or Correction Protocol post-build entry that touches
the built page again starts a fresh count if it re-invokes this loop,
rather than inheriting a prior run's count.

## Rules

- **No agent introduces a choice that doesn't originate in the previous
  agent's output.** This is the chain's core discipline — enforced by
  `landing-critic`'s traceability audit, not by tooling, so treat a
  critic redline with the same weight a failed typecheck gets elsewhere
  in Hedgehog.
- **Ingredients move in agreement.** Color, type, space, motion, copy
  rhythm, and pacing are reconciled into one system at phase 6 — a
  mismatch (warm color, cold type) is a defect `landing-systems` owns
  fixing, not a later polish pass.
- **Sequential except phases 5's two parallel inputs.** The Ingredient
  Director and Copywriter sub-steps inside `landing-systems` read the
  same sorted-adjectives input and can run together; every other phase
  waits on the one before it. This is design, not a gap to close: the
  chain is a linear sequence (`src/golden-cores/landing-page/core.yaml`),
  so `hedgehog claim --count N` always returns one task — there is no
  scheduler fan-out to reason about here, and this core's docs stay free
  of the conflict-predicate machinery that `full-stack-app` needs.
- **A wrong phase gets fixed at its source** — the Correction Protocol,
  not a downstream workaround (e.g. don't patch the Builder's output to
  fix a token that's wrong at the Systems Designer level).
- **The Critic's veto is real.** `landing-critic` can send any phase back
  to its owning agent, citing which audit failed; it cannot rewrite the
  artifact itself.

## Core Reference Points

The chain's judgment calls, across every phase, are grounded in these —
not restated per-agent since they're shared foundation, not one phase's
procedure:

- Donald Norman, *Emotional Design* — visceral / behavioral / reflective
  (`landing-strategist`'s step 3)
- Scott McCloud, *Understanding Comics* — panel transition taxonomy,
  closure (`landing-sequencer`'s step 7)
- Will Eisner, *Comics and Sequential Art* — page as one composition
  before it's a sequence (`landing-sequencer`'s step 7)
- Rudolf Arnheim, *Art and Visual Perception* — visual weight, tension,
  balance (`landing-systems`'s step 4a/5 dial reconciliation)
- Josef Albers, *Interaction of Color* — color as relational, not
  absolute (`landing-systems`'s step 4a color dial)
- Dieter Rams / Massimo Vignelli — restraint as an emotional register
  (`landing-critic`'s Chanel cut, step 8)

## Stop Condition

Offer the fresh-context handoff once the Polish Loop above has exited
(clean or capped) — not at the `artifact` task's completion directly, the
way `hedgehog-loop`'s Stop Condition works. The `artifact` task being
`complete` opens the Polish Loop; the Polish Loop exiting is what actually
ends the build session. The subject statement or an adjective being
genuinely ambiguous mid-chain is the other, earlier trigger, same as
before. Nothing gets deleted either way — the permanent record is the
committed intent (`.hedgehog/intents/landing.json`), `.hedgehog/chain/`,
the friction log, and the git commit history itself, including every
`feat(landing): polish iteration <n>` commit the loop made.
`.hedgehog/hedgehog.db` is gitignored: a derived index, rebuildable at
any time via `hedgehog db rebuild`.

Confirm it with `hedgehog boundary` before offering the handoff: it exits
0 only when nothing is in flight, the working tree is clean, and the last
closed task completed its intent, and names which of the three failed
otherwise. `hedgehog quiesce` answers only the in-flight third — the
right check while waiting out a correction, not the one for clearing
context. The same command is what decides any mid-chain `/clear` too, and
`hedgehog boundary --handoff` prints the block the next session opens
with: where the build is, what's next and why, and what's blocked.

Tell the user plainly that the build (including the polish pass) is
complete, and that clearing context now costs nothing — the chain
artifacts, the build graph, and the commit log hold everything a fresh
session needs. Name **both** ways forward:

- **Adjustments to what's built** — a `tweaker` session, in a *new* chat
  window, not a subagent call inside this one. Tell the user plainly:
  close this chat window and open a new one, then paste this to start
  it:

  > The build is complete — `landing-builder` built the page and the
  > Polish Loop (`landing-executor` plus `landing-visual-reviewer` and
  > `landing-ux-reviewer`) has finished polishing it. Use the tweaker
  > agent: first review the friction log and ask me for feedback on the
  > build, then take my tweak requests one at a time.

  If the Polish Loop exited at its 10-iteration cap with redlines still
  open, say so explicitly in this handoff too, so the fresh `tweaker`
  session knows to treat those as its first tweak requests rather than
  assuming the page is fully clean.

**New scope** — anything beyond adjusting what exists — and on this
core the deciding question is whether `.hedgehog/chain/00-brief.md`
still holds:

- **It holds** (a new section on a page whose subject, audience, and
  job are unchanged): this core has no module axis to add an intent
  to — the `landing` intent already compiles into the fixed five-phase
  chain, and a section is new content inside phases already `complete`,
  not a new graph row. Route it to the Correction Protocol's post-build
  entry instead of `planner`: re-run `landing-sequencer` to place the
  new section in the beat structure, then `landing-headline-writer` and
  `landing-copywriter` for that section only, `landing-critic` against
  the full patched chain, then `landing-builder` to rebuild the
  artifact — each its own small commit, same as any other correction.
- **It doesn't hold** (a different subject, audience, or job): that's a
  different page, and belongs in its own landing-page project via
  `planner`'s first run there, not an edit to this one's locked brief.
  Never rewrite `00-brief.md` to accommodate new scope — it's the root
  every phase's traceability audit walks back to.

Don't start making tweaks or planning new scope in the current,
already-large context; that's what the fresh session is for.
