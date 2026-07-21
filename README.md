# Hedgehog

A build discipline for AI-guided software projects - an alternative to
BMAD, Superpowers, and traditional PRD-driven workflows.

The fox knows many tricks while the hedgehog knows one thing and does it well. Unlike other systems, Hedgehog uses an opinionated way of building for the AI era:

## Principles
1. Without guard-rails, AI projects baloon into unmaintainable ...

## The problem

PRD-driven frameworks describe a product in **slices**: a user story that
touches UI, backend, and business logic all at once. That forces every decision, including the architecture, to be made up front, before the team or the AI has enough context to make it well.

It also mixes concerns that don't belong together: a screen's layout has nothing to do with a domain model's invariants, but a slice-shaped PRD asks you to design both in the same breath.

This front-loads ceremony instead of building: a PRD is written and reviewed before a single tested line of code exists, and that document becomes context the AI has to hold onto for the rest of the project.

The bigger cost shows up later. A PRD locks decisions in as if they were facts, then tests get written against those decisions. When reality disagrees with the PRD, the correction isn't a small local fix - it's a course correction against a document that says otherwise, which makes changing course feel like a failure instead of the normal cost of learning something the plan couldn't have known yet.

The result is the opposite of the **last responsible moment**: decisions get locked in early, at the point of highest ignorance, instead of at the
point of most information.

When a PRD turns out to be wrong, the fix is a
new round of ceremony - re-plan, re-review re-sign-off - rather than a small, local correction.

## The Hedgehog approach

Build backend-first, root-dependency order, every time:

```
types → data → contracts → domain logic → Thin API → hooks → screens
```

The backend (schema and domain logic) is built and proven first.

The contract - the typed boundary derived from
the schema - is fixed early, so the shape of the API is set by what the data and domain actually are, not guessed at in advance.

The API layer is a thin wire-up over that contract not a design surface in its own right.

The frontend arrives last, as a consumer of a finished, stable API, never a co-designer of it.

This preserves the last responsible moment naturally: UI decisions happen only once the backend and contract that constrain them already exist.

New features can then work as easy scoped slices instead of heavy PRD documents.

### Ordered Work Graphs
Instead of a PRD, Hedgehog uses an **ordered work graph**: a small,
dependency-aware checklist (`TODO.md`) where each step is one schema, one
contract, one service - built, tested, and committed before the next step
starts. The commit log becomes the record of what was built and why,
replacing the sign-off documents PRD-driven frameworks rely on.

## Why this suits AI-assisted building

Large, ambiguous instructions ("build this feature") degrade AI
performance - context gets noisy, assumptions compound, mistakes are hard
to roll back.

Small, ordered, verified steps don't have that problem: each
one is independently understandable, testable, and revertible.

Hedgehog's
loop - pick the next step, build it, test it, commit it - is the discipline
version of that idea, applied consistently rather than left to chance.

## Where to look

- [`CLAUDE.md`](CLAUDE.md) - how this repo itself is worked on.
- [`docs/hedgehog-principles.md`](docs/hedgehog-principles.md) - what
  Hedgehog is and its core stance.
- [`docs/hedgehog-intake.md`](docs/hedgehog-intake.md) - the input spec:
  what a project must supply (scope boundary, domain vocabulary) before
  build starts.
- [`docs/hedgehog-stack.md`](docs/hedgehog-stack.md) - the locked stack.
- [`docs/hedgehog-order.md`](docs/hedgehog-order.md) - the build sequence
  and module definition.
- [`docs/hedgehog-logic.md`](docs/hedgehog-logic.md) - the enforcement
  config that makes Stack and Order mechanically true.
- [`docs/hedgehog-operating-instructions.md`](docs/hedgehog-operating-instructions.md)
  - the operating loop a project built with Hedgehog imports.
