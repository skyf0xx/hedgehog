---
name: hedgehog-planning-intake
description: Use on any core for first-run planning intake — Phase 0 runs the vendored BMAD-METHOD planning shelf, shared by every core, and Phase 1 (mining `04-prd.md` into intent records plus the Add-ons/sync-and-remote-entities decision) is full-stack-app's and pwa-app's shared procedure — identical mechanics, a different decision at step 5/8. Phase 0 also defines compressed intake, the path a user's explicit "just build it" choice takes on full-stack-app, pwa-app, and authored cores: one batched round of questions in place of the shelf, writing the same archive at the same path so Phase 1, `ux-planner`, and the Re-entry pass all keep their documented source. Also use for the Re-entry pass, which mines new scope into additional intents without re-running the shelf, on any core with a module axis to add an intent to (full-stack-app, pwa-app, authored) — landing-page has none, so its own new-scope path runs through `hedgehog-landing-loop`'s Correction Protocol instead. Invoked by the `planner` agent, which decides the path; don't run standalone. landing-page runs this skill's Phase 0 on first run, then mines the same archive through `hedgehog-landing-loop`'s own planning-intake section, that core's counterpart to this skill's Phase 1. copywriting runs this skill's Phase 0 the same way, then mines the same archive through `hedgehog-copywriting-loop`'s own planning-intake section into a what/audience/register brief — no module axis, so its own new-scope path runs through that loop's Correction Protocol rather than the Re-entry pass below. An authored core runs this skill's Phase 0, then `hedgehog-core-design`, then this skill's Phase 1 mining against the designed layer sequence. A brownfield adoption (`hedgehog-adopt`) never runs this skill's shelf at all — the drivers BMAD elicits are already settled facts of a repo that already exists.
---

# Hedgehog Planning Intake

Turns a person's description of a problem into planning material, by
running the vendored BMAD-METHOD planning shelf (Phase 0, shared by
every core) and mining its output. On full-stack-app and pwa-app that
mining is this skill's own Phase 1, into intent records written via
`hedgehog intent
add`; on landing-page it's `hedgehog-landing-loop`'s planning-intake
section, into a subject/audience/job statement; on copywriting it's
`hedgehog-copywriting-loop`'s planning-intake section, into a
what/audience/register brief. This is the mechanics
`planner` calls once its Phase 0 core-selection check has picked a core —
the interpretive judgment (which Feature becomes which intent, Confirm &
Lock either way) belongs to `planner`; this skill (Phase 0, and Phase 1 on
full-stack-app and pwa-app), `hedgehog-landing-loop` (landing-page's own
mining), and `hedgehog-copywriting-loop` (copywriting's own mining) are
the fixed procedures that judgment runs inside.

That shelf run is a **first run**, once per project. When new scope
enters play later on a core with a module axis (full-stack-app, pwa-app,
authored), `planner` runs the **Re-entry pass** at the end of this file
instead: it reads the existing archive as context and elicits only what's
new, adding intents to a graph that keeps everything already built.
Landing-page has no module axis for this pass to add an intent to; its
own new-scope path runs through `hedgehog-landing-loop`'s Correction
Protocol post-build entry instead — see that skill, not this one.

## Phase 0 — BMAD elicitation (every core, first run only)

Phase 0 and Phase 1 below are the **first run** — a project whose build
graph holds no intents yet. When the graph already holds intents, run the
**Re-entry pass** at the end of this file instead; the shelf does not run
twice on one project.

Run Phase 0 in the session already talking to the user, never as a
detached subagent — every skill below can drop into Facilitator or
Creative Partner mode, a live multi-turn conversation a subagent has no
channel to hold (`planner.md` states the same constraint). Applies
regardless of which core invoked this Phase — `hedgehog-landing-loop`
runs it in full too.

Check `uv` is on PATH before anything else — every skill in the shelf
below shells out to it (`uv run {bmad-root}/scripts/*.py`) for its
memlog, customization resolution, and research tooling, so its absence
mid-shelf strands a run partway through rather than failing at the one
point where the whole shelf is still skippable. Run `uv --version`; if
it fails (not found, or exits non-zero), stop before running any BMAD
skill and tell the user plainly: `uv` is required by the vendored BMAD
planning shelf and isn't on PATH — install it
(https://docs.astral.sh/uv/getting-started/installation/) and re-run.
Don't fall back to a reduced or headless shelf run on this failure;
that's a silent behavior change of exactly the kind this check exists
to prevent.

State the BMAD attribution, then run the vendored shelf in full
sequence — on a first run there is no per-project skip logic and no
reduced default set:

1. `bmad-forge-idea` (`vendor-skills/BMAD/core-skills/bmad-forge-idea`) —
   pressure-test the idea through persona-driven interrogation before
   diverging on it; strengthens, rejects, or clarifies it, optionally
   writing `forged-idea.md` as input to the skills below.
2. `bmad-brainstorming` (`vendor-skills/BMAD/core-skills/bmad-brainstorming`) —
   diverge on the idea before locking anything.
3. `bmad-product-brief` (`vendor-skills/BMAD/bmm-skills/plan/bmad-product-brief`)
   — the product brief.
4. `bmad-prfaq` (`vendor-skills/BMAD/bmm-skills/plan/bmad-prfaq`) — vets
   the idea press-release-style.
5. `bmad-prd` (`vendor-skills/BMAD/bmm-skills/plan/bmad-prd`) — the
   PRD, including its Glossary (entities, relationships, cardinality).
6. `bmad-ux` (`vendor-skills/BMAD/bmm-skills/plan/bmad-ux`) — the UX
   spec, `DESIGN.md` + `EXPERIENCE.md`.
7. `bmad-deep-recon` (`vendor-skills/BMAD/core-skills/bmad-deep-recon`) —
   market/competitive/user-voice research.

Any skill may itself invoke `bmad-advanced-elicitation`
(`vendor-skills/BMAD/core-skills/bmad-advanced-elicitation`) at its own pause
points — that's expected, let it run.

Write each skill's output to `.hedgehog/BMAD/`, per the fixed layout:

```
.hedgehog/BMAD/
  00-manifest.md        # attribution + pinned version + date + which skills ran
  01-brainstorming.md
  02-brief.md
  03-prfaq.md
  04-prd.md
  05-ux-spec/
    DESIGN.md
    EXPERIENCE.md
  06-research.md
```

Every file/folder carries a one-line attribution header. `00-manifest.md`
states the source repo, pinned version (`vendor-skills/BMAD/ATTRIBUTION.md` has
the pinned commit), date, which intake mode ran (`full`, below, or
`compressed`), and which skills ran.

### Compressed intake (full-stack-app, pwa-app, authored core)

A user who opens with "just build it" — no clarifying questions — is
asking for something Phase 0's live elicitation can't give them.
`planner` surfaces that conflict rather than resolving it silently (see
that agent), and **compressed intake is the defined path when the user
chooses it**. It is never the default and never offered as the
easier option: it runs only on an explicit choice, after the conflict has
been named.

Compressed intake replaces the shelf with **one batched round of
questions covering only what can't be inferred from the user's brief**,
then writes the archive below directly. Everything else about intake is
unchanged — Phase 1 mining, Confirm & Lock, and the Add-ons gate all run
exactly as they do on a full run, against the archive this mode writes.

Not available on landing-page: that core's whole chain is a traceability
audit rooted in a subject statement mined from BMAD's material, so
compressing the elicitation removes the thing the chain audits against.
A "just build it" landing-page request is a conflict to surface, not a
mode to switch into.

**The Add-ons decision (or, on pwa-app, the sync/remote-entities
decision) is what the batched round is for.** Auth, Queue, and Mobile
(full-stack-app) or sync and remote entities (pwa-app) must each be
*answered*: inferred from a concrete
trigger in the user's brief, or asked directly in that one round.
Compressed intake compresses BMAD's elicitation, never `planner`'s gate;
a boolean left as a guess is the same error here as on a full run.

Write the manifest and the PRD always, and the experience spec where the
brief gives it something to say — at the same path and in the same
layout:

```
.hedgehog/BMAD/
  00-manifest.md        # mode: compressed, date, what the batched round covered
  04-prd.md             # §3 Glossary and §4 Features only, mined from the brief
  05-ux-spec/
    EXPERIENCE.md       # flows and behaviour, where the brief states them
```

- **`04-prd.md`** carries the load: Phase 1 below reads §3 Glossary and
  §4 Features, so compressed intake writes exactly those two sections,
  derived from the brief plus the batched answers, in the shape that
  mining table expects. Not a full BMAD PRD — the minimum shape Phase 1
  can walk.
- **`05-ux-spec/EXPERIENCE.md`** only where the brief actually states
  flows or behaviour ("a list you can filter", "mark done inline"). No
  `DESIGN.md`: visual identity is what a compressed brief is least
  likely to state, and inventing one is exactly the improvisation this
  mode exists to prevent. `ux-planner` reads whichever of the two the
  archive holds, and treats an absent file as its cue to ask (see that
  agent).
- **`01-brainstorming.md`, `02-brief.md`, `03-prfaq.md`, and
  `06-research.md` are not written.** Those exist on a full run to
  produce a good PRD; compressed intake reaches the PRD by a different
  route. `00-manifest.md` naming them as not-run is the record — an
  empty placeholder file is not.

`00-manifest.md` states `mode: compressed`, the date, which files were
written and which weren't, what the batched round asked, and which
add-ons were answered directly versus triggered by the brief. That
manifest is the single record of how this project was planned: **the
archive exists on every core after intake, whichever mode ran**, so an
absent `.hedgehog/BMAD/` means intake never ran, not that a compressed
path was taken.

On an authored core, `hedgehog-core-design` reads this archive to pick a
stack and derive layers. A compressed PRD is thinner input for that than
a full shelf run, so say so plainly at that skill's own Confirm & Lock —
the architecture is being designed from a brief rather than from elicited
drivers, and that's the user's call to accept there.

`.hedgehog/BMAD/` is archival and immutable once written, on every core.
Nothing in `hedgehog-loop`'s day-to-day operation, `hedgehog-bootstrap`,
or `reviewer` reads this folder live — `planner` reads it exactly once,
right after the shelf completes, to mine it (this skill's Phase 1 below
on full-stack-app and pwa-app; `hedgehog-landing-loop`'s planning-intake
section on
landing-page). After that it's historical record only, the same
relationship the commit log has to a merged PR.

## Phase 1 — Mining (full-stack-app, pwa-app)

landing-page's counterpart to this Phase 1 is
`hedgehog-landing-loop`'s own planning-intake section, run once Phase 0
above completes: it mines the same `.hedgehog/BMAD/` archive into a
subject/audience/job statement, in place of the intents this Phase 1
produces.

Read `.hedgehog/BMAD/04-prd.md` only — §3 Glossary and §4 Features.
Nothing else in `.hedgehog/BMAD/` is read again: brainstorming, brief,
PR-FAQ, and deep-recon existed to produce a good PRD, and the UX spec is
read later, once per module, by `ux-planner`, not by this mining pass.
This is the same read on either intake mode — a compressed archive writes
those two sections directly, so mining has its documented source
whichever mode ran.
Mining is mechanical, not interpretive — one graph row per PRD element,
per this table:

| PRD element | Graph row |
| --- | --- |
| §4 Feature | one `intents` row — the feature's description already reads as `goal` + `outcome` |
| FR "Consequences (testable)" item | `requirements` row, `kind='acceptance'` |
| Feature-specific NFR / cross-cutting rule | `requirements` row, `kind='rule'` |
| §3 Glossary relationship/cardinality | `intent_dependencies` row (the referencing feature's intent depends on the referenced feature's intent) |

Procedure:

1. **Walk §4 Features top to bottom.** For each Feature, that's one
   intent: `id` a short kebab-case slug of the Feature's name, `goal` and
   `outcome` drawn directly from the Feature's description (split the
   description across the two if it names both the capability and the
   result; otherwise the same sentence can serve both).

   On a module-axis core (`full-stack-app`, `pwa-app`, and any authored
   core whose
   layers scope by `{module}`), **name the id plural** — `tasks`, not
   `task`; `order-items`, not `order-item`. The id is substituted as
   `{module}` into every layer's scope glob and verify command, and the
   generators each layer's packet names take the module plural, so a
   singular id compiles a graph scoped to a directory the generator will
   never write. This is the moment that choice is cheapest: it is one
   string here, and a Correction Protocol case across every compiled task
   three layers later. `hedgehog intent add` and `hedgehog plan` both
   report an id that looks singular — `plan` for as long as none of that
   intent's tasks has been started, since every route into the graph
   (`--file`, a hand-written intent file, `db rebuild`) converges there.
   Both are advisory: `billing` and `search` are legitimately singular, so
   read the report and decide, rather than renaming on sight.
2. **Walk that Feature's FRs.** Each FR's "Consequences (testable)" list
   items become that intent's `requirements` with `kind='acceptance'`,
   one per item, verbatim or lightly tightened — no rephrasing that
   changes what's being tested.
3. **Collect any NFR or cross-cutting rule scoped to that Feature**
   (not a project-wide NFR with no single owning Feature) as a
   `requirements` row with `kind='rule'` on that intent.
4. **Walk §3 Glossary relationships and cardinality.** Each relationship
   between two entities that belong to different Features' intents
   becomes one `intent_dependencies` row: the intent for the entity
   holding the foreign key depends on the intent for the entity it
   references. A relationship entirely inside one Feature's entities
   produces no row — it's already the same intent.
5. **Run this core's Add-ons-equivalent decision** (`planner`'s own
   judgment call): full-stack-app's "The Add-ons decision" (Auth, Queue,
   Mobile), or pwa-app's "The sync/remote-entities decision" (sync,
   remote entities) — see that agent.
6. **Run Confirm & Lock** (below) before writing anything.
7. **Write each intent via `hedgehog intent add`** — one invocation per
   Feature: `--acceptance` per row from step 2, `--rule` per row from step
   3, `--depends-on` per row from step 4, or an equivalent `--file
   <path.json>` batch matching the same shape (`{ id, goal, outcome,
   rules, acceptance, depends_on, priority }`). This is Phase 1's only
   write to the build graph.
8. **Write `.hedgehog/addons.yaml`** with the decision from step 5.
9. **Fill root `CLAUDE.md`'s `{{PROJECT_NAME}}` and `{{PROJECT_SUMMARY}}`
   placeholders**, first run only, then delete the installer's HTML
   comment block at the top of that file. Leave every other line
   untouched.

This is the first-run sequence. New scope entering play later runs the
**Re-entry pass** below, which has its own steps.

## Confirm & Lock (first run)

Everything through Phase 1 mining is provisional and cheap to change —
nothing has been written yet. This stage is the last point before that
stops being true, so it's a hard stop, not a recap in passing.

🔒 **Confirm & Lock**. Show, in full, not condensed:

- Each intent about to be added: `id`, `goal`, `outcome`, its
  `requirements` (rule/acceptance), and its `depends_on` list.
- This core's Add-ons-equivalent decision, each boolean explicitly on or
  off with the one-line reason (Auth / Queue / Mobile on full-stack-app;
  sync / remote entities on pwa-app).
- Which intake mode ran, and on a full run which BMAD skills ran — or,
  on a compressed run, what the batched round asked and what was inferred
  from the brief without asking. Either way, where the output lives
  (`.hedgehog/BMAD/`).

Then state plainly what happens on confirmation, before it happens:

> This writes each intent above via `hedgehog intent add` and the
> decision above to `.hedgehog/addons.yaml`, then shows the compiled
> graph with `hedgehog status`. Phase A build (schema first) starts on
> the first ready task once that closes. Anything wrong or missing — say
> so now; it's a normal edit before this point, and a Correction Protocol
> entry after. Confirm to proceed, or tell me what to change.

Wait for an explicit go-ahead. A revision here is just another mining
pass — update the draft, re-run this stage, don't write anything until
the confirmation holds. Once confirmed, after every `hedgehog intent add`
call lands, run `hedgehog status` and show it in full as the graph's
confirmation view.

## Re-entry pass — new scope on an existing project (full-stack-app, pwa-app, authored core)

Runs when `planner`'s Workflow step 2 finds intents already in the graph,
on a core with a module axis to add an intent to: new scope entering play
on a project that's already been built or is mid-build. Landing-page has
no module axis — its equivalent runs through
`hedgehog-landing-loop`'s Correction Protocol post-build entry, not this
pass. Adding one module is not a reason to re-interview a project from
scratch, so **the BMAD shelf does not run again** and `.hedgehog/BMAD/`
is not rewritten — it's read as context, exactly the historical-record
relationship Phase 0 describes.

This works because the graph is append-only by construction:
`hedgehog plan` only compiles intents still `proposed`/`planned`, and
skips any intent whose tasks already exist. Adding scope cannot disturb
work already done — completed tasks keep their `complete` status and
their commits.

1. **Read `.hedgehog/BMAD/` for context**, chiefly `02-brief.md` and
   `04-prd.md` — what this project is, and what its existing vocabulary
   calls things. Read `00-manifest.md` first for which of those the
   archive actually holds: on a compressed archive that's `04-prd.md` and
   the manifest's own record of the batched round, which carry the same
   two things this step needs (the product, and its vocabulary).
   Read-only. The new scope has to sit inside the same product and reuse
   its terms; you're extending a project, not starting a neighbouring
   one.
2. **Read the existing graph**: `hedgehog status` for what's built, and
   the existing intent ids for the vocabulary already in play. New scope
   names must not collide with an existing intent id.
3. **Elicit only what's new.** A short, scoped set of questions — not a
   full interview:
   - What is the new scope, in the project's own vocabulary?
   - Which entities/tables does it introduce? On full-stack-app and
     pwa-app each table is its own module, same rule as Phase 1.
   - What does it depend on that already exists? Each answer becomes a
     `--depends-on` onto an existing intent.
   - What has to be true for it to be done? Each answer becomes an
     `--acceptance` row.
   - Any cross-cutting rule scoped to this new module specifically (not a
     project-wide NFR)? Each answer becomes a `--rule` row — same as
     Phase 1 step 3, asked here only if the new scope actually has one.

   If the answers reveal this isn't new scope at all but a change to
   something already built, stop: that's the Correction Protocol, not an
   extension.
4. **Check whether any boolean trigger actually changed**
   (full-stack-app's Add-ons, or pwa-app's sync/remote-entities). Usually
   none has. Only if the new scope genuinely introduces one — the
   first accounts in a project that had none, the first long-running job,
   the first shared device on a pwa-app project, the first entity that
   must be server-authoritative —
   edit `.hedgehog/addons.yaml`, and say plainly that turning a boolean on
   after bootstrap needs its Bootstrap step run before anything depends on
   it. Never rewrite root `CLAUDE.md`'s `{{PROJECT_NAME}}`/
   `{{PROJECT_SUMMARY}}` placeholders here; they describe the project,
   which hasn't changed.
5. **Run Confirm & Lock (extension)** below.
6. **Write the new intents** via `hedgehog intent add`, one call per new
   module, then run **`hedgehog plan`**. Never re-add or edit an intent
   already in the graph. `plan` reports one compiled line per new intent
   and nothing else — intents already built are `active`/`complete`, so
   `plan` never even reads them. If it reports compiling something you
   didn't just add, stop: an existing intent was edited by mistake.
7. **Show `hedgehog status` in full**, then hand to this core's loop
   skill; `hedgehog next` now emits the first task of the new work.

`planner` commits this pass as `chore(planning): extend scope` — distinct
from `chore(planning): intake` on a first run, so the two are
distinguishable in the log.

**Dependency direction is forward only.** A new intent may depend on an
existing one — the edge lands on that intent's last layer, so the new
chain is ready immediately when the upstream module is already complete.
An existing intent can never be made to depend on a new one: those edges
are written when the depending intent compiles, and that already
happened. If new scope genuinely needs to sit *underneath* something
already built, that's a Correction Protocol case, not a re-entry.

### Confirm & Lock (extension)

Same hard stop as the first-run stage above — show in full, not
condensed, and wait for an explicit go-ahead before writing anything.
Show:

- Each **new** intent about to be added: `id`, `goal`, `outcome`, its
  `requirements`, and its `depends_on` list — naming which existing
  modules those dependencies point at.
- The existing intents, named, stated explicitly as untouched.
- Any add-on change from step 4, or "no add-on triggers changed."

State plainly, before it happens: this adds the intents above via
`hedgehog intent add`, then compiles them with `hedgehog plan` — existing
work is untouched (`plan` skips intents already compiled, every
`complete` task keeps its status), and the build resumes at the first
task of the new scope.
