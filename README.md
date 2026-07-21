# Hedgehog

Hedgehog is a build discipline for AI-guided software projects: one
opinionated way of building software, held as standing defaults, applied
the same way on every project. Given a **WHAT** (a business need), the
discipline converts it into a product through a fixed **way of working**.

The fox knows many tricks; the hedgehog knows one thing and does it well.

## Core stance

Hedgehog builds backend-first, root-dependency order, every time:

```
types → data → contracts → domain logic → thin API → hooks → screens
```

The backend (schema and domain logic) is built and proven first. The
contract — the typed boundary derived from the schema — is fixed early,
so the shape of the API is set by what the data and domain actually are.
The API layer is a thin wire-up over that contract, not a design surface
in its own right. The frontend arrives last, as a consumer of a finished,
stable API.

This puts every decision at the **last responsible moment**: a screen's
layout has nothing to do with a domain model's invariants, so Hedgehog
never asks for both in the same breath. UI decisions happen only once the
backend and contract that constrain them already exist.

**Fix forward, fix small.** When a downstream step reveals an upstream
assumption was wrong, the correction patches the upstream step directly
and fast-forwards the small set of dependents that broke, each its own
atomic commit. The commit log is the explanation.

**Escape hatch:** for novel UX or exploratory products that don't
decompose cleanly root-first — vibecode a rough draft, mine it for domain
vocabulary only, discard the code, then build hedgehog-style. The draft
never gets promoted directly into the structure.

## Ordered work graphs

Hedgehog replaces a PRD with an **ordered work graph**: a small,
dependency-aware checklist (`TODO.md`) where each step is one schema, one
contract, one service — built, tested, and committed before the next
step starts. The commit log becomes the record of what was built and
why.

A PRD describes a product in slices: a user story that touches UI,
backend, and business logic all at once, forcing every decision —
including the architecture — to be made up front, before there's enough
context to make it well. It also front-loads ceremony: a document gets
written and reviewed before a single tested line of code exists, and
when reality disagrees with it later, the fix is a new round of
ceremony rather than a small, local correction. Hedgehog's ordered work
graph keeps every step small, verified, and revertible instead.

## Why this suits AI-assisted building

Large, ambiguous instructions ("build this feature") degrade AI
performance — context gets noisy, assumptions compound, mistakes are
hard to roll back. Small, ordered, verified steps don't have that
problem: each one is independently understandable, testable, and
revertible. Hedgehog's loop — pick the next step, build it, test it,
commit it — applies that discipline consistently.

## The stack

One locked, opinionated stack removes recurring per-project arguments:
Nx monorepo, pnpm, NestJS, Drizzle + PostgreSQL, ts-rest + Zod contracts,
Better Auth, TanStack Query, Next.js + ShadCN + Tailwind (Expo + React
Native Reusables + NativeWind for mobile), BullMQ + Redis, Pino, and
Conventional Commits enforced by lefthook. The `hedgehog-bootstrap` skill
carries the full table and the config that enforces it.

## What this repo is

This repo is the discipline itself: a package of Claude Code agents and
skills a project imports to work Hedgehog-style, and the source of the
method.

- `agents/` — the subagent roles a consuming project copies into its own
  `.claude/agents/`: `planner` (Intake, module scoping), `ux-planner`
  (interaction/layout rationale, once per module at the start of
  Phase B), `ui-builder` (frontend build steps), `reviewer` (phase
  transition checks, Correction Protocol review).
- `skills/` — the packaged procedures a consuming project copies into
  its own `.claude/skills/`: `hedgehog-bootstrap` (scaffolds a new
  project once, wires in enforcement config), `hedgehog-loop` (the
  operating loop for every unit of work after bootstrap), and
  `conventional-commits` (reconstructs step-shaped commit history when
  work didn't land cleanly as it went).
- `TODO.md` — the template for a consuming project's live build
  checklist, copied to that project's repo root.

A consuming project's own root `CLAUDE.md` points at these agents and
skills; the `hedgehog-loop` skill is the entry point for day-to-day work
once `hedgehog-bootstrap` has run.
