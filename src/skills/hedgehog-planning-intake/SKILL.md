---
name: hedgehog-planning-intake
description: Use when `planner` runs first-run planning intake on a core whose intake opens with the vendored BMAD-METHOD shelf, or chooses compressed intake after a user asks not to be asked questions, or adds new scope to a full-stack-app, pwa-app, or authored project that already has intents (the Re-entry pass). Holds the shared shelf (Phase 0), its archive layout, compressed intake, and the PRD-to-intent mining (Phase 1). Invoked by `planner`, which decides the path; don't run standalone.
---

# Hedgehog Planning Intake

Turns a person's description of a problem into planning material, by
running the vendored BMAD-METHOD planning shelf (Phase 0) and mining its
output. `planner`'s "Per-core intake" names, for every core, which parts
of this skill run, which core skill mines the archive instead of Phase 1,
and where new scope goes later. This skill holds the fixed procedures;
the interpretive judgment (which Feature becomes which intent, Confirm &
Lock either way) belongs to `planner`.

## Phase 0 — BMAD elicitation (first run only)

Phase 0 and Phase 1 below are the **first run** — a project whose build
graph holds no intents yet. The shelf runs once per project: new scope
later goes where `planner`'s "Per-core intake" sends it (the **Re-entry
pass** at the end of this file, on the cores it covers), never through
the shelf again. deepseek-harness is the exception: its intake can run
the shelf once per plugin, and `hedgehog-dsh-loop`'s Planning intake
governs each run's archive.

Run Phase 0 in the session already talking to the user, never as a
detached subagent — every skill below can drop into Facilitator or
Creative Partner mode, a live multi-turn conversation a subagent has no
channel to hold. This applies whichever core's intake invoked it.

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

State the BMAD attribution `planner`'s Phase 1 gives, then run the
vendored shelf in full sequence — on a first run there is no per-project
skip logic and no reduced default set:

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

**Full-shelf carve-out on copywriting.** This core has no module axis —
`hedgehog-copywriting-loop`'s mining step (in its planning-intake
section) draws only from `02-brief.md` and `03-prfaq.md`, never
`04-prd.md` or `05-ux-spec/`. On a full run, stop the shelf after
`bmad-prfaq` (step 4) — or after `bmad-deep-recon` (step 7) where the
piece genuinely needs market/competitive/user-voice research — and skip
`bmad-prd` and `bmad-ux` entirely. Neither has a module axis, a UI
surface, or anything else to attach to on this core, so running them
produces planning artifacts nothing downstream reads. `00-manifest.md`
names `bmad-prd` and `bmad-ux` as not-run, the same as any other skipped
step on this shelf.

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
the pinned commit), date, which intake mode ran (`full`, above, or
`compressed`, below), and which skills ran.

### Compressed intake (full-stack-app, pwa-app, authored core, copywriting)

A user who opens with "just build it" — no clarifying questions — is
asking for something Phase 0's live elicitation can't give them.
`planner` surfaces that conflict rather than resolving it silently, and
**compressed intake is the defined path when the user chooses it**. It is
never the default and never offered as the easier option: it runs only
on an explicit choice, after the conflict has been named.

Compressed intake replaces the shelf with **one batched round of
questions covering only what can't be inferred from the user's brief**,
then writes a thinned archive at the same paths a full run uses. It
writes exactly the files this core's archive readers (see "Who reads the
archive" below) read, and nothing else: a file that isn't written is named as not-run in `00-manifest.md`,
never left as an empty placeholder. Everything else about intake is
unchanged — mining, Confirm & Lock, and any boolean gate all run exactly
as they do on a full run, against the archive this mode writes.

**What the round covers and what the archive holds, per core:**

- **full-stack-app, pwa-app, authored core** — what the round covers
  differs by core:
  - full-stack-app and pwa-app: the boolean decision. Auth, Queue, and
    Mobile (full-stack-app) or sync and remote entities (pwa-app) must
    each be *answered*, inferred from a concrete trigger in the user's
    brief or asked directly in that one round, per the gate `planner`'s
    "The Add-ons decision" states. Compressed intake compresses BMAD's
    elicitation, never that gate.
  - authored core: there is no boolean decision. The round covers the
    drivers `hedgehog-core-design` designs from and the brief leaves
    open: the system shape, the ecosystem the target users already work
    in, the deployment target, and any hard constraint on stack or
    platform.

  All three write the same archive:

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

  On an authored core, `hedgehog-core-design` reads this archive to pick
  a stack and derive layers. A compressed PRD is thinner input for that
  than a full shelf run, so say so plainly at that skill's own Confirm &
  Lock — the architecture is being designed from a brief rather than
  from elicited drivers, and that's the user's call to accept there.
- **copywriting** — the round covers exactly what
  `hedgehog-copywriting-loop`'s mining step needs and can't infer from
  the request: what's being written (the concrete piece), the audience,
  and the register — three questions, or fewer where the request already
  answers one. There is no boolean gate on this core. A short, low-stakes
  piece (a single UI microcopy string, a one-off product-announcement
  paragraph) is the case this mode fits. The archive:

  ```
  .hedgehog/BMAD/
    00-manifest.md   # mode: compressed, date, what the batched round asked
    02-brief.md      # what's being written + audience, from the brief + batched round
    03-prfaq.md      # register, from the brief + batched round
  ```

  That mining step reads these two files exactly as it does on a full
  run, so a thinned archive changes only how much material informed it.

Not available on landing-page: that core's whole chain is a traceability
audit rooted in a subject statement mined from BMAD's material, so
compressing the elicitation removes the thing the chain audits against.
A "just build it" landing-page request is a conflict to surface, not a
mode to switch into.

`00-manifest.md` states `mode: compressed`, the date, which files were
written and which weren't, what the batched round asked, and which
booleans were answered directly versus triggered by the brief. That
manifest is the single record of how this project was planned: **the
archive exists after intake whichever mode ran**, so an absent
`.hedgehog/BMAD/` means intake never ran (or ran on a path with no
archive: deepseek-harness's mechanical path, adopted), not that a
compressed path was taken.

### Who reads the archive

`.hedgehog/BMAD/` is archival and immutable once written, on every core.
Its readers are exactly these:

- the mining pass, once, right after the shelf completes — Phase 1 below,
  or the core skill that replaces it (`hedgehog-landing-loop`,
  `hedgehog-copywriting-loop`, `hedgehog-dsh-loop`'s BMAD path);
- `hedgehog-core-design`, on an authored core, before Phase 1;
- `ux-planner` (full-stack-app), which reads `05-ux-spec/` once per
  module;
- `landing-builder` (landing-page), which reads `04-prd.md`'s
  Features/FRs and `05-ux-spec/` at the stages its own file names;
- `landing-copywriter` (landing-page), which reads `04-prd.md`'s
  Hero/Core Claim feature at Stage 4, where it exists;
- the Re-entry pass below, as context for new scope.

No core loop's day-to-day operation, no bootstrap skill, and no
`reviewer` read it.

## Phase 1 — Mining (full-stack-app, pwa-app, authored core)

Read `.hedgehog/BMAD/04-prd.md` only — §3 Glossary and §4 Features.
Brainstorming, brief, PR-FAQ, and deep-recon existed to produce a good
PRD and are not read again here, and the UX spec is read later by its
own readers (above), not by this mining pass. This is the same read on
either intake mode — a compressed archive writes those two sections
directly, so mining has its documented source whichever mode ran.
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
5. **Run this core's boolean decision**, where it has one: `planner`'s
   "The Add-ons decision" (full-stack-app) or "The sync/remote-entities
   decision" (pwa-app).
6. **Run Confirm & Lock** (below) before writing anything.
7. **Write each intent via `hedgehog intent add`** — one invocation per
   Feature: `--acceptance` per row from step 2, `--rule` per row from step
   3, `--depends-on` per row from step 4, or an equivalent `--file
   <path.json>` batch matching the same shape (`{ id, goal, outcome,
   rules, acceptance, depends_on, priority }`). This is Phase 1's only
   write to the build graph.
8. **Write `.hedgehog/addons.yaml`** with the decision from step 5, on a
   core that had one (full-stack-app, pwa-app). An authored core writes
   no `addons.yaml`.
9. **Fill root `CLAUDE.md`'s `{{PROJECT_NAME}}` and `{{PROJECT_SUMMARY}}`
   placeholders**, first run only, then delete the installer's HTML
   comment block at the top of that file. Leave every other line
   untouched.

`planner`'s Workflow steps 7–9 cover what follows: when `hedgehog plan`
runs, the commit, and the `bootstrap` handoff.

## Confirm & Lock (first run)

Everything through Phase 1 mining is provisional and cheap to change —
nothing has been written yet. This stage is the last point before that
stops being true, so it's a hard stop, not a recap in passing.

🔒 **Confirm & Lock**. Show, in full, not condensed:

- Each intent about to be added: `id`, `goal`, `outcome`, its
  `requirements` (rule/acceptance), and its `depends_on` list.
- This core's boolean decision, where it has one, each boolean
  explicitly on or off with the one-line reason (Auth / Queue / Mobile on
  full-stack-app; sync / remote entities on pwa-app).
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

Runs when `planner`'s Workflow step 2 finds intents already in the graph
on one of these cores: new scope entering play on a project that's
already been built or is mid-build. `planner`'s "Per-core intake" routes
new scope on every other core. Adding one module is not a reason to
re-interview a project from scratch, so **the BMAD shelf does not run
again** and `.hedgehog/BMAD/` is not rewritten — it's read as context.

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
7. **Show `hedgehog status` in full.**
8. **Commit the pass** per `planner`'s Workflow step 8, then hand to this
   core's loop skill; `hedgehog next` emits the first task of the new
   work.

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
