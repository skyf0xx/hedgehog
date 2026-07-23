---
name: hedgehog-planning-intake
description: Use once per project, at the start, and again on a scoped pass when new domain scope enters play — runs the vendored BMAD-METHOD planning shelf, mines its output into scope boundary/domain modules/the Add-ons decision, and gates on Confirm & Lock before anything is written. Invoked by the `planner` agent; don't run standalone.
---

# Hedgehog Planning Intake

Turns a person's description of a problem into `TODO.md` (with its
`## Add-ons` block) and `docs/design/<module>-notes.md` per module, by
running the vendored BMAD-METHOD planning shelf and mining its output.
This is the mechanics `planner` calls once its "does Hedgehog apply at
all" check passes — the interpretive judgment (scope boundary, module
split, Add-ons decision, Confirm & Lock) still belongs to `planner`; this
skill is the fixed procedure that judgment runs inside.

## Phase 0 — BMAD elicitation

State the BMAD attribution, then run the vendored shelf in full
sequence, every time — no per-project skip logic, no reduced default
set:

1. `bmad-brainstorming` (`skills/BMAD/core-skills/bmad-brainstorming`) —
   diverge on the idea before locking anything.
2. `bmad-product-brief` (`skills/BMAD/bmm-skills/1-analysis/bmad-product-brief`)
   — the product brief.
3. `bmad-prfaq` (`skills/BMAD/bmm-skills/1-analysis/bmad-prfaq`) — vets
   the idea press-release-style.
4. `bmad-prd` (`skills/BMAD/bmm-skills/2-plan-workflows/bmad-prd`) — the
   PRD, including its Glossary (entities, relationships, cardinality).
5. `bmad-ux` (`skills/BMAD/bmm-skills/2-plan-workflows/bmad-ux`) — the UX
   spec, `DESIGN.md` + `EXPERIENCE.md`.
6. `bmad-deep-recon` (`skills/BMAD/core-skills/bmad-deep-recon`) —
   market/competitive/user-voice research.

Any skill may itself invoke `bmad-advanced-elicitation`
(`skills/BMAD/core-skills/bmad-advanced-elicitation`) at its own pause
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
states the source repo, pinned version (`skills/BMAD/ATTRIBUTION.md` has
the pinned commit), date, and which skills ran.

`.hedgehog/BMAD/` is archival and immutable once written. Nothing in
`hedgehog-loop`'s day-to-day operation, `hedgehog-bootstrap`, or
`reviewer` reads this folder live — `planner` reads it exactly once,
right after the shelf completes, to mine it. After that it's historical
record only, the same relationship the commit log has to a merged PR.

## Phase 1 — Mining

Read `.hedgehog/BMAD/` once and do the interpretive work BMAD's docs
don't do for you — none of BMAD's outputs contain a ready-made
Auth/Queue/Mobile toggle or a module-ownership/FK table; the PRD's
Glossary is the closest thing, but it's vocabulary-shaped prose, not a
decision table:

1. **Scope boundary** — derive from the brief's Scope section plus the
   PRD's Glossary/Features. In scope: what the elicited material actually
   called for. Out of scope: anything the brief or PRD flagged as
   deferred, painful-but-not-now, or explicitly excluded.
2. **Domain modules** — derive from the PRD's Glossary (entity,
   relationships, cardinality): one table = one module, same rule as
   Hedgehog has always used. A cluster with its own lifecycle, referenced
   by other things, is a candidate module; a thing mentioned only as a
   property of another isn't.
3. **Cross-module references** — from the Glossary's relationships/
   cardinality, identify which module's schema holds the FK, so build
   order between modules is clear before anyone writes a schema.
4. **Add-ons decision** (Auth, Queue, Mobile) — check BMAD's docs (brief,
   PRD, UX spec) for each trigger first:
   - **Auth** — on if the material describes accounts, logins, or
     per-user/per-account data.
   - **Queue** — on if at least one described operation is genuinely
     long-running, needs retries, or fans out.
   - **Mobile** — on if the material explicitly wants a mobile app
     alongside or instead of web.

   Infer first, gap-fill second — this is not a second full interview.
   For any add-on the text leaves genuinely unresolved (not mentioned
   either way), ask the user directly, the same direct-question posture
   as an ambiguous scope boundary: "does this need user accounts/login,
   or is it just for you?", "is anything here a background job, or is it
   all instant reads and writes?", "web only, or mobile too?" A "no" is a
   resolved answer, not a gap. Never default an add-on on or off without
   either a concrete trigger in BMAD's docs or a direct answer — an
   unasked add-on question is a guess.
5. **Run Confirm & Lock** (below) before writing anything.
6. **Write `TODO.md`** — the checklist mirroring Bootstrap, Phase A, and
   Phase B steps per module and add-on in scope, plus the `## Add-ons`
   block (see "The Add-ons block" below).
7. **File `docs/design/<module>-notes.md` per module** — sourced from
   `.hedgehog/BMAD/05-ux-spec/EXPERIENCE.md` (information architecture,
   states, flows) and `DESIGN.md` (visual identity): file each module's
   slice into its own notes file, same fixed filename pattern, same
   "every module gets one, even if empty" rule as always — a module with
   no UX-spec material yet still gets a `docs/design/<module>-notes.md`
   stating that plainly, not a missing file. `ux-planner` reads this file
   as raw screen/flow material at that module's Phase B.
8. **Fill root `CLAUDE.md`'s `{{PROJECT_NAME}}` and `{{PROJECT_SUMMARY}}`
   placeholders**, first run only, then delete the installer's HTML
   comment block at the top of that file. Leave every other line
   untouched.

On a later run (new scope entering play), skip steps 4 and 8 unless new
scope genuinely changes an add-on trigger (e.g. accounts get added where
there were none) or the project's identity itself changed — append new
module sections to `TODO.md` only, never touch an existing module's
checked boxes or reorder modules already in progress.

## The Add-ons block

`TODO.md` carries the Add-ons decision directly — no side-channel
document. Write a short, fixed-format `## Add-ons` block into `TODO.md`:

```
## Add-ons
- Auth: on — accounts/login in scope
- Queue: off — no long-running ops
- Mobile: off — not requested
```

Each line: the add-on, on/off, a one-line reason it landed there. This is
the single stable, machine-checkable field every downstream check reads
— `hedgehog-bootstrap`, `bootstrap`, `hedgehog-loop`, and `reviewer` all
check `TODO.md`'s `## Add-ons` block, not any other file. An absent
`## Add-ons` block reads as "never decided," not "decided off" — those
two are distinct and downstream checks treat them differently.

## Confirm & Lock

Everything through Phase 1 mining is provisional and cheap to change —
nothing has been written yet. This stage is the last point before that
stops being true, so it's a hard stop, not a recap in passing.

🔒 **Confirm & Lock**. Show, in full, not condensed:

- The scope boundary (in / out), sourced from the brief + PRD.
- The Add-ons decision (Auth / Queue / Mobile, each explicitly on or
  off, with the one-line reason — from BMAD's docs or a direct answer).
- The domain vocabulary / module list, in build order, with any
  cross-module FK dependencies flagged.
- Which BMAD skills ran and where their output lives
  (`.hedgehog/BMAD/`).

Then state plainly what happens on confirmation, before it happens:

> This locks in `TODO.md` (with the `## Add-ons` block) and
> `docs/design/<module>-notes.md` per module, and hands off to the
> `bootstrap` agent to scaffold the workspace and whichever add-ons are
> on. Phase A build (schema first) starts on the first module once that
> closes. Anything wrong or missing — say so now; it's a normal edit
> before this point, and a Correction Protocol entry after. Confirm to
> proceed, or tell me what to change.

Wait for an explicit go-ahead. A revision here is just another mining
pass — update the draft, re-run this stage, don't write anything until
the confirmation holds.
