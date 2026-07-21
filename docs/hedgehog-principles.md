# Hedgehog: Principles

## What This Is

Hedgehog is one opinionated way of building software: a build discipline,
held as standing defaults, applied the same way on every project. Given a
**WHAT** (a business need), the discipline converts it into a product
through a fixed **way of working** — the root step everything else depends
on.

## How We Think About It

The way of working comes first. Intake feeds it exactly two things: scope
boundary and domain vocabulary.

Core stance: **backend-first, root-dependency order.** Types before data,
data before logic, logic before API, API before hooks, hooks before
screens. UI is a thin, final consumer of a stable backend.

**Last responsible moment** falls out of small commits and root-first
order. Mistakes surface at the cheapest point — a type error at commit 3,
not a UI bug at commit 30. The compiler and tests are the status field.

**Fix forward, fix small.** When a downstream step reveals an upstream
assumption was wrong: patch the upstream step, fast-forward the small set
of dependents that broke, each its own atomic commit.

**Escape hatch:** for novel UX or exploratory products that don't
decompose cleanly root-first — vibecode a rough draft, mine it for domain
vocabulary only, discard the code, then build hedgehog-style. The draft
never gets promoted directly into the structure.

## The Artifacts

The repo and commit log are the artifacts, generated as a byproduct of
working. Vocabulary (this doc), Stack, and Order are the three standing
defaults. Logic is the config that enforces them. TODO.md tracks what to
build right now. Everything else lives in code and the commit log.

## Build Sequence (applies to Hedgehog itself, same as any project)

1. Vocabulary / principles — this doc.
2. Types — standing defaults (Stack, Order, Unit of Work, Correction Rule,
   Scope Boundary).
3. Logic — how those defaults get applied/enforced.
4. API — the operating checklist/prompt an AI or builder actually consumes.
5. Screens/tooling — anything user-facing. Last.
