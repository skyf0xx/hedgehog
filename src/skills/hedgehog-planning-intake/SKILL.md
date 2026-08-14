---
name: hedgehog-planning-intake
description: Use on any core for first-run planning intake — Phase 0 runs the vendored BMAD-METHOD planning shelf, shared by every core, and Phase 1 (mining `04-prd.md` into intent records plus the Add-ons decision) is full-stack-app's own procedure. Also use for the Re-entry pass, which mines new scope into additional intents without re-running the shelf, on any core with a module axis to add an intent to (full-stack-app, authored) — landing-page has none, so its own new-scope path runs through `hedgehog-landing-loop`'s Correction Protocol instead. Invoked by the `planner` agent, which decides the path; don't run standalone. landing-page runs this skill's Phase 0 on first run, then mines the same archive through `hedgehog-landing-loop`'s own planning-intake section, that core's counterpart to this skill's Phase 1. An authored core runs this skill's Phase 0, then `hedgehog-core-design`, then this skill's Phase 1 mining against the designed layer sequence. A brownfield adoption (`hedgehog-adopt`) never runs this skill's shelf at all — the drivers BMAD elicits are already settled facts of a repo that already exists.
---

# Hedgehog Planning Intake

Turns a person's description of a problem into planning material, by
running the vendored BMAD-METHOD planning shelf (Phase 0, shared by both
cores) and mining its output. On full-stack-app that mining is this
skill's own Phase 1, into intent records written via `hedgehog intent
add`; on landing-page it's `hedgehog-landing-loop`'s planning-intake
section, into a subject/audience/job statement. This is the mechanics
`planner` calls once its Phase 0 core-selection check has picked a core —
the interpretive judgment (which Feature becomes which intent, Confirm &
Lock either way) belongs to `planner`; this skill (Phase 0, and Phase 1 on
full-stack-app) and `hedgehog-landing-loop` (landing-page's own mining)
are the fixed procedures that judgment runs inside.

That shelf run is a **first run**, once per project. When new scope
enters play later on a core with a module axis (full-stack-app,
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
the pinned commit), date, and which skills ran.

`.hedgehog/BMAD/` is archival and immutable once written, on every core.
Nothing in `hedgehog-loop`'s day-to-day operation, `hedgehog-bootstrap`,
or `reviewer` reads this folder live — `planner` reads it exactly once,
right after the shelf completes, to mine it (this skill's Phase 1 below
on full-stack-app; `hedgehog-landing-loop`'s planning-intake section on
landing-page). After that it's historical record only, the same
relationship the commit log has to a merged PR.

## Phase 1 — Mining (full-stack-app only)

landing-page's counterpart to this Phase 1 is
`hedgehog-landing-loop`'s own planning-intake section, run once Phase 0
above completes: it mines the same `.hedgehog/BMAD/` archive into a
subject/audience/job statement, in place of the intents this Phase 1
produces.

Read `.hedgehog/BMAD/04-prd.md` only — §3 Glossary and §4 Features.
Nothing else in `.hedgehog/BMAD/` is read again: brainstorming, brief,
PR-FAQ, and deep-recon existed to produce a good PRD, and the UX spec is
read later, once per module, by `ux-planner`, not by this mining pass.
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

   On a module-axis core (`full-stack-app`, and any authored core whose
   layers scope by `{module}`), **name the id plural** — `tasks`, not
   `task`; `order-items`, not `order-item`. The id is substituted as
   `{module}` into every layer's scope glob and verify command, and the
   generators each layer's packet names take the module plural, so a
   singular id compiles a graph scoped to a directory the generator will
   never write. This is the only moment that choice is cheap: it is one
   string here, and a Correction Protocol case across every compiled task
   three layers later.
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
5. **Run the Add-ons decision** (`planner`'s own judgment call — see that
   agent's "The Add-ons decision") for Auth, Queue, and Mobile.
6. **Run Confirm & Lock** (below) before writing anything.
7. **Write each intent via `hedgehog intent add`** — one invocation per
   Feature: `--acceptance` per row from step 2, `--rule` per row from step
   3, `--depends-on` per row from step 4, or an equivalent `--file
   <path.json>` batch matching the same shape (`{ id, goal, outcome,
   rules, acceptance, depends_on, priority }`). This is Phase 1's only
   write to the build graph.
8. **Write `.hedgehog/addons.yaml`** with the Add-ons decision from step 5.
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
- The Add-ons decision (Auth / Queue / Mobile, each explicitly on or
  off, with the one-line reason).
- Which BMAD skills ran and where their output lives
  (`.hedgehog/BMAD/`).

Then state plainly what happens on confirmation, before it happens:

> This writes each intent above via `hedgehog intent add` and the
> Add-ons decision to `.hedgehog/addons.yaml`, then shows the compiled
> graph with `hedgehog status`. Phase A build (schema first) starts on
> the first ready task once that closes. Anything wrong or missing — say
> so now; it's a normal edit before this point, and a Correction Protocol
> entry after. Confirm to proceed, or tell me what to change.

Wait for an explicit go-ahead. A revision here is just another mining
pass — update the draft, re-run this stage, don't write anything until
the confirmation holds. Once confirmed, after every `hedgehog intent add`
call lands, run `hedgehog status` and show it in full as the graph's
confirmation view.

## Re-entry pass — new scope on an existing project (full-stack-app, authored core)

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
   calls things. Read-only. The new scope has to sit inside the same
   product and reuse its terms; you're extending a project, not starting
   a neighbouring one.
2. **Read the existing graph**: `hedgehog status` for what's built, and
   the existing intent ids for the vocabulary already in play. New scope
   names must not collide with an existing intent id.
3. **Elicit only what's new.** A short, scoped set of questions — not a
   full interview:
   - What is the new scope, in the project's own vocabulary?
   - Which entities/tables does it introduce? On full-stack-app each
     table is its own module, same rule as Phase 1.
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
4. **Check whether any add-on trigger actually changed** (full-stack-app).
   Usually none has. Only if the new scope genuinely introduces one — the
   first accounts in a project that had none, the first long-running job —
   edit `.hedgehog/addons.yaml`, and say plainly that turning an add-on on
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
