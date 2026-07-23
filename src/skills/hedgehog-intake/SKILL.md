---
name: hedgehog-intake
description: Use for Intake — the elicitation and synthesis procedure that turns a person's description of what they want to build into a scope boundary, an add-ons decision, and domain vocabulary. Invoked by the planner agent at the start of a project, and again (scoped to what's new) whenever new scope enters play. Triggers on "let's start", a fresh project with no docs/context.md, or the planner agent's own Intake step.
---

# Hedgehog Intake

Turns a person's description of a problem — narration, existing material,
or both — into scope boundary, an add-ons decision, and domain
vocabulary, through elicitation and synthesis. The build sequence for
*how* a module gets built and the phase rules for *when* frontend work
can start are fixed elsewhere (`hedgehog-loop`) — Intake decides *what's*
in scope and what the domain looks like before any schema gets written.

## Does Hedgehog apply at all

Before anything else, on a project's first Intake only: check whether the
description names any persistent domain data with its own lifecycle at
all — something that gets created, changes state, gets queried back later.
If it doesn't (a static marketing page, a one-off script, a slide deck, a
pure design exercise with no backend concern), say so plainly and stop —
Hedgehog's discipline (schema → contract → repository → service →
controller) has nothing to attach to without at least one domain module,
and forcing the sequence onto something with no state to model just adds
ceremony with no payoff. This is a real bail-out, not a formality: don't
soften it into "let's proceed with a minimal module anyway" if truly
nothing qualifies.

This is a distinct question from project *size*. A single-table, single-
user tool (one person's task list, a personal habit tracker) still has a
real domain module — it stays in Hedgehog, scoped through the Add-ons
question below, not exempted here. The bar for skipping Hedgehog entirely
is "no domain module exists," not "the domain module is small."

## Opening the first Intake

Before eliciting anything, on a project's first Intake only, state the
order of work and why, in a sentence or two: this builds backend-first —
schema, then contract, then domain logic, then a thin API — proven
working before any screen gets built. Screens, layout, and "how it should
feel" are part of the same conversation and get captured along with
everything else; deciding and building from them is Phase B's job
(`ux-planner` and `ui-builder`), module by module, once a finished API
exists to build against. State this once, plainly, so it's clear talking
about screens now means capturing for later, not building now.

Elicitation anchors on one concrete pass through the thing, start to
finish — imagined for a new idea, remembered for an existing workflow
being replaced. A concrete walkthrough surfaces the real nouns and verbs:
who uses it, what they do, what comes out the other end.

The extracted vocabulary is a first draft, revised the moment it's
written up or the schema step exposes something the interview missed.
Revising a draft is a normal edit — the Correction Protocol
(`hedgehog-loop` skill) applies to it like any other step.

## What Intake produces

1. **Scope boundary** — what's in, what's explicitly out.
2. **Add-ons decision** — Auth, Queue, Mobile, each explicitly on or off
   (see "Add-ons" below). First Intake only; a later Intake only revisits
   this if new scope genuinely changes the trigger (e.g. accounts get
   added where there were none).
3. **Domain vocabulary** — the nouns and verbs of the problem.
4. **`docs/context.md`** — the product narrative, scope boundary, add-ons
   decision, and domain vocabulary, written as current state (see below).
   Mandatory, every project gets one.
5. **Root `CLAUDE.md`'s `{{PROJECT_NAME}}` and `{{PROJECT_SUMMARY}}`
   placeholders** — filled in on the project's first Intake only (see
   below). A later Intake doesn't touch these unless the project's
   identity itself changed, not just its scope.
6. **Screen/flow notes** — captured by module in
   `docs/design/<module>-notes.md`, a fixed filename pattern (`-notes` is
   the literal suffix, applied to every module regardless of its name),
   for `ux-planner` to act on at that module's Phase B (see below).
   Mandatory per module in scope, even when nothing was offered for that
   module.

## Screens, flows, and other visual input

A screenshot, mockup, or existing tool the person points to is fair game
at Intake as a source of entities, attributes, and workflow steps — a
competitor's app, a sketch, or a spreadsheet works the same as narration
here, and doubles as raw material for Phase B later.

Layout, styling, and interaction described — "the dashboard should show X
and Y together," "this should feel like Stripe's checkout" — are
captured under the relevant module in `docs/design/<module>-notes.md`.
`ux-planner` turns this into a screen rationale once that module's
contract and hook exist, in Phase A build order. Name this in the moment:
"noted for `<module>`'s screen — that gets built after its API is
working."

Every module in scope gets this file, whether or not anything was
offered for it — a module with no screen input yet still gets a
`docs/design/<module>-notes.md` stating that plainly, not a missing
file.

## Interview formatting

The interview is the whole UI — there's no screen to lean on, so
structure carries the weight a layout normally would. Keep a light,
consistent set of markers so the person can tell at a glance what kind of
turn they're reading, without turning the transcript noisy:

- A bold section title on entering a new stage (`**Scope**`,
  `**Domain vocabulary**`, `**Confirm & lock**`) — once per stage, not
  once per message.
- 🧭 for the opening brain-dump prompt, ❓ for a single follow-up
  question, 🔍 for reading supplied material (a screenshot, a
  spreadsheet), 📋 for a synthesis recap, 🔒 for the final confirmation
  gate. One icon per turn, at most — this marks the kind of turn, it
  isn't decoration.
- Tables for anything tabular (scope boundary, vocabulary) — never
  prose pretending to be a table.
- Short paragraphs, one question per turn (already required below) —
  never stack multiple asks in one block just because both fit.

This applies to every Intake turn from here on, not just the ones
below.

## Confidence tracking

Track a running confidence estimate for "I know what this person
actually wants" — not "I have enough to start guessing." Confidence
rises only when an answer resolves genuine ambiguity; a detail that
just restates something already clear doesn't move it.

State it out loud periodically as elicitation progresses — after
synthesis produces a draft, and any time confidence is low enough that
continuing to guess would be worse than asking:

> Confidence: ~70% — clear on the core flow and the actors, still open
> on what "cancel" means once payment's been taken, and whether
> `status` is a single lifecycle or independent tags.

Keep asking until confidence reaches **95%**: every module has a
resolved "owned by," at least one out-of-scope item has surfaced, and
no term is doing double duty for two different lifecycles (see "When
to ask instead of guess," below). 95% is a floor on understanding
what's real, not a ceiling on how much detail to gather — don't pad the
interview past the point where more questions stop resolving
ambiguity. If the person answers "I don't know, just pick something,"
that's a resolved answer (their call, recorded as such) — it moves
confidence up, not down.

Never silently settle for "what I think they should want." If a
guess would fill a gap, surface it as a candidate to confirm or
correct instead of writing it into the draft unchallenged — this is
the same move as "offering a candidate boundary... to confirm or
correct" below, applied to every gap, not just scope.

## Elicitation — what to ask

Open with room for a full brain dump, not a question: "Describe what you
want to build, however makes sense to you — who uses it, what they do,
what comes out the other end. I'll ask follow-ups after."

Ask up front whether anything already shows it — a screenshot of a
similar tool, a spreadsheet, a sample document, a sketch. Read or look at
whatever exists before asking questions it already answers — a
screenshot of a cluttered spreadsheet can surface entities and attributes
faster than ten minutes of narration.

Once the dump and any source material are on the table, close gaps with
questions anchored to one concrete pass through the thing, start to
finish — a remembered instance if this replaces an existing workflow, an
imagined one otherwise:

- "Walk me through someone using this, start to finish — what do they
  do, in what order."
- "What goes in, and what comes out the other end — a decision, a
  record, a notification?"
- "What are the different kinds of [cases/orders/requests/whatever the
  person calls them] this handles, and what actually differs between
  them?"
- "Who else is involved, and what do they need from this or give it?"
- "What's explicitly not in the first version?" — surfaces candidates
  for out-of-scope.
- "What's a case that wouldn't fit the normal pattern?" — surfaces edge
  cases and the real invariants.

Ask one question at a time. Prefer a question the person can answer by
picking from a short concrete set over a fully open one, when honest to
offer (e.g. "is that a status the case moves through, or a tag that can
apply more than one at a time?" beats "tell me more about status"). When
a term is doing double duty — one word for two things needing different
lifecycles — name the ambiguity and ask them to split it.

Close with "anything else?"

Questions stay behavioral, anchored to a concrete pass through the thing
or material already on hand. Once enough is on the table, offering a
candidate boundary or vocabulary split to confirm or correct is fair
game.

Scale the session to the stakes. A solo tool for one person's own
workflow needs less pressure-testing than a system others will depend
on — read which one this is early and let it set the pace.

## Synthesis — turning answers into structure

1. **Cluster the nouns.** Recurring actors, records, or objects. A
   cluster with its own lifecycle, referenced by other things, is a
   candidate domain module. A thing mentioned only as a property of
   another (e.g. "shipping address" always attached to an order) is an
   attribute, not a module.
2. **Cluster the verbs.** Actions that mutate state and carry their own
   invariants (e.g. "cancel an order, but only before payment") become
   service methods later. Pure CRUD doesn't need naming.
3. **Draft the scope boundary.** In scope: what the described instances
   actually required. Out of scope: anything flagged painful-but-not-now,
   deferred, or explicitly unwanted — named explicitly. A boundary needs
   at least one named exclusion; if none surfaced, ask one more question.
4. **Decide the add-ons** (first Intake only — see "Add-ons" below): Auth,
   Queue, Mobile, each on or off, from what's actually in the scope
   boundary just drafted. Don't default to "on" for any of them; each
   needs a concrete trigger from the description, not a guess at what a
   "real" project usually has.
5. **Write the draft vocabulary as a table**: entity, one-sentence
   definition, the attributes that came up, what it's owned by/belongs
   to.
6. **Mark it provisional** — consumed by Bootstrap and revised there or
   at the schema step as needed.
7. **Run Confirm & lock** (below) before writing anything. Only after
   the person confirms does synthesis proceed to steps 8–10.
8. **Write `docs/context.md`**: product narrative, scope boundary, the
   add-ons decision, and the domain vocabulary table, stated as current
   state only — no record of alternatives considered, no "originally X,
   now Y." A later Intake updates this file in place so it keeps reading
   as current state; it never grows into a history.
9. **Fill root `CLAUDE.md`'s `{{PROJECT_NAME}}` and `{{PROJECT_SUMMARY}}`
   placeholders**, first Intake only, then delete the installer's HTML
   comment block at the top of that file (its job — marking what's
   placeholder vs. constant — is done once both are filled). Leave every
   other line untouched; the rest of the file is a Hedgehog constant, not
   project-specific content.
10. **File screen/flow notes** under their module in
    `docs/design/<module>-notes.md`, the fixed filename pattern from
    "What Intake produces" above, one file per module in scope, even
    when nothing was offered for that module (say so plainly instead of
    omitting the file) — verbatim or lightly organized, raw material for
    `ux-planner`, not a rationale, so don't polish or structure beyond
    attributing it to the right module.

## Add-ons

Hedgehog's core stack (Nx, NestJS, Drizzle, Postgres, Docker Compose,
ts-rest, Next.js — see `hedgehog-bootstrap`) applies to every project.
Three pieces of infra beyond that core are add-ons, each independently on
or off, decided here rather than assumed:

- **Auth** — on if the description involves accounts, logins, or
  per-user/per-account data (anything one person shouldn't see another's
  version of). Off for a single-user tool with no login concept at all
  ("just for me," no sharing, no multi-tenancy).
- **Queue** — on if at least one described operation is genuinely
  long-running, needs retries, or fans out (sending a batch of emails,
  processing an upload, anything that shouldn't block a request). Off if
  every operation the person described is a direct, synchronous read or
  write — the common case for a small tool.
- **Mobile** — on if the person explicitly wants a mobile app alongside
  or instead of web. Off otherwise.

Ask directly rather than inferring silently, the same way an ambiguous
scope boundary gets a direct question instead of a guess: "does this need
user accounts/login, or is it just for you?", "is anything here a
background job — something that keeps running after the request
finishes — or is it all instant reads and writes?", "web only, or mobile
too?" A "no" is a resolved answer, not a gap — it moves confidence up the
same way any other resolved ambiguity does. Record all three explicitly in
`docs/context.md`, even when off — an absent Add-ons section reads as
"never decided," not "decided off," and `hedgehog-bootstrap` needs to
distinguish those two.

## Confirm & lock

Everything above this point is provisional and cheap to change — nothing
has been written yet. This stage is the last point before that stops
being true, so it's a hard stop, not a recap in passing.

🔒 **Confirm & lock**. Show, in full, not condensed:

- The scope boundary table (in / out).
- The add-ons decision (Auth / Queue / Mobile, each explicitly on or
  off, with the one-line reason each landed where it did).
- The domain vocabulary table (entity, definition, attributes, owned
  by).
- The module list in build order, with any cross-module FK dependencies
  flagged.
- The confidence estimate, and what it's based on (e.g. "95% — every
  module has a resolved owner, one out-of-scope item confirmed, no
  double-duty terms remaining").

Then state plainly what happens on confirmation, before it happens:

> This locks in `docs/context.md` and the per-module design notes, and
> hands off to the `bootstrap` agent to scaffold the workspace and
> whichever add-ons are on. Phase A build (schema first) starts on the
> first module once that closes. Anything wrong or missing — say so
> now; it's a normal edit before this point, and a Correction Protocol
> entry after. Confirm to proceed, or tell me what to change.

Wait for an explicit go-ahead. A revision here is just another
elicitation turn — update the draft, re-run this stage, don't write
anything until the confirmation holds. Don't lower the bar because the
person seems eager to start; the cost of a wrong schema is exactly why
this gate exists.

## Worked example

**Account given**: "I want an app like this" — a screenshot of a
competitor's habit tracker — "but for tracking medication instead. You
check off each dose, and it should nag you if you miss one." The
screenshot supplies the shape (items with a name, a check-off action, a
streak); one follow-up question supplies the rest — "walk me through
someone using this, start to finish" surfaces that doses have times, not
just days, and that "nag" means a notification, not an in-app-only
indicator.

**Scope boundary**

- In scope: add a medication with a schedule, mark a dose taken, missed-
  dose notification.
- Out of scope: refill tracking, prescriber integration, multiple users
  sharing one list.

**Add-ons**: Auth off (single user, "multiple users sharing one list" is
explicitly out of scope — no login concept at all). Queue on (a missed-
dose notification has to fire later, on its own, independent of any
request — exactly the long-running/decoupled case the Queue add-on
exists for). Mobile off (not mentioned; ask before assuming either way if
it genuinely didn't come up).

**Domain vocabulary**

| Entity | Definition | Key attributes | Owned by |
|---|---|---|---|
| `medications` | a tracked medication | name, schedule | - |
| `doses` | one scheduled instance of a medication | due_at, taken_at | belongs to `medications` |

Verbs: add a medication, mark a dose taken, notify on a missed dose.

This is enough to start Bootstrap.

A remembered workflow produces the same structure: a lawyer describing
how they currently triage client intake by email surfaces `clients`,
`cases`, and `documents` via "walk me through the last time this came
up" in place of "walk me through someone using this."

## When to ask instead of guess

If no out-of-scope item has surfaced, or an entity's "owned by" doesn't
resolve to a plain FK, ask one more targeted question. A wrong guess here
becomes the schema, the most disruptive place to correct it — cheaper to
ask now than fix forward later.
