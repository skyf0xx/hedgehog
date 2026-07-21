# Hedgehog: Intake

The person describes what they want to build, in their own words -
narration, existing material, or both. Hedgehog extracts scope boundary
and domain vocabulary from that description through elicitation and
synthesis.

Elicitation anchors on one concrete pass through the thing, start to
finish - imagined for a new idea, remembered for an existing workflow
being replaced. A concrete walkthrough surfaces the real nouns and
verbs: who uses it, what they do, what comes out the other end.

The extracted vocabulary is a first draft, revised the moment step 1
(Vocabulary) or Order's step 1 (Schema) exposes something the interview
didn't surface. Revising a draft is a normal edit - Order's Correction
Protocol applies to it like any other step.

## What Intake produces

1. **Scope boundary** - what's in, what's explicitly out.
2. **Domain vocabulary** - the nouns and verbs of the problem.

Screens, flows, UI preferences, and "how it should feel" are Phase B
concerns and get redirected there when they surface (Operating
Instructions).

### Screens, flows, and other visual input

A screenshot, mockup, or existing tool the person points to is fair
game at Intake as a source of entities, attributes, and workflow steps -
a competitor's app, a sketch, or the spreadsheet the person already
lives in works the same as narration for this purpose. Redirect to
Phase B only what's actually about layout, styling, or interaction.
Phase B starts from the vocabulary and scope boundary Intake produces,
not from the material itself.

## Elicitation - what to ask

Open with room for a full brain dump, not a question. Something like:
"Describe what you want to build, however makes sense to you - who uses
it, what they do, what comes out the other end. I'll ask follow-ups
after."

Ask up front whether anything already shows it - a screenshot of a
similar tool, a spreadsheet, a sample document, a sketch. Read or look
at whatever exists before asking questions it already answers - a
screenshot of a cluttered spreadsheet can surface entities and
attributes faster than ten minutes of narration. See Screens, flows,
and other visual input, above, for what that material is and isn't used
for.

Once the dump and any source material are on the table, close gaps with
questions anchored to one concrete pass through the thing, start to
finish - a remembered instance if this replaces an existing workflow, an
imagined one otherwise:

- "Walk me through someone using this, start to finish - what do they
  do, in what order."
- "What goes in, and what comes out the other end - a decision, a
  record, a notification?"
- "What are the different kinds of \[cases/orders/requests/whatever the
  person calls them\] this handles, and what actually differs between
  them?"
- "Who else is involved, and what do they need from this or give it?"
- "What's explicitly not in the first version?" - surfaces candidates
  for out-of-scope.
- "What's a case that wouldn't fit the normal pattern?" - surfaces edge
  cases and the real invariants.

Ask one question at a time. Prefer a question the person can answer by
picking from a short concrete set over a fully open one, when a set is
honest to offer (e.g. "is that a status the case moves through, or a tag
that can apply more than one at a time?" beats "tell me more about
status"). When a term the person uses is doing double duty - the same
word for two things that turn out to need different lifecycles - name
the ambiguity and ask them to split it.

Close with "anything else?"

Questions stay behavioral, anchored to a concrete pass through the
thing or material the person already has. Once enough is on the table,
offering a candidate boundary or vocabulary split for the person to
confirm or correct is also fair game.

Scale the session to the stakes. A solo tool for one person's own
workflow needs less pressure-testing than a system other people will
depend on - read which one this is early and let it set the pace.

## Synthesis - turning answers into structure

1. **Cluster the nouns.** Recurring things mentioned as actors, records,
   or objects. A cluster with its own lifecycle, referenced by other
   things, is a candidate domain module. A thing mentioned only as a
   property of another thing (e.g. "shipping address" always attached to
   an order) is an attribute, not a module.
2. **Cluster the verbs.** Actions that mutate state and carry their own
   invariants (e.g. "cancel an order, but only before payment") become
   service methods later. Pure CRUD doesn't need naming.
3. **Draft the scope boundary.** In scope: what the described instances
   actually required. Out of scope: anything flagged as
   painful-but-not-now, deferred, or explicitly unwanted - named
   explicitly. A boundary needs at least one named exclusion; if none
   surfaced, one more question closes the gap.
4. **Write the draft vocabulary as a table**: entity, one-sentence
   definition, the attributes that came up, what it's owned by/belongs
   to.
5. **Mark it provisional**, consumed by step 1 (Vocabulary) and revised
   there or at Order's step 1 (Schema) as needed.

## Worked Example

**Account given**: "I want an app like this" - a screenshot of a
competitor's habit tracker - "but for tracking medication instead. You
check off each dose, and it should nag you if you miss one." The
screenshot supplies the shape (items with a name, a check-off action, a
streak); one follow-up question supplies the rest - "walk me through
someone using this, start to finish" surfaces that doses have times, not
just days, and that "nag" means a notification, not an in-app-only
indicator.

**Scope boundary**

- In scope: add a medication with a schedule, mark a dose taken, missed-
  dose notification.
- Out of scope: refill tracking, prescriber integration, multiple users
  sharing one list.

**Domain vocabulary**

| Entity | Definition | Key attributes | Owned by |
|---|---|---|---|
| `medications` | a tracked medication | name, schedule | - |
| `doses` | one scheduled instance of a medication | due_at, taken_at | belongs to `medications` |

Verbs: add a medication, mark a dose taken, notify on a missed dose.

This is enough to write Vocabulary (Principles, step 1) and start
Bootstrap.

A remembered workflow produces the same structure: a lawyer describing
how they currently triage client intake by email surfaces `clients`,
`cases`, and `documents` via "walk me through the last time this came
up" in place of "walk me through someone using this."

## When to ask instead of guess

Per the Stop Condition (Operating Instructions): if no out-of-scope item
has surfaced, or an entity's "owned by" doesn't resolve to a plain FK, ask
one more targeted question. A wrong guess here becomes the schema in
Order's step 1, the most disruptive place to correct it - cheaper to ask
now than fix forward later.
