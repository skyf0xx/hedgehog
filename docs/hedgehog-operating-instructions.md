# Hedgehog — Operating Instructions

This file is context for an AI or builder at the start of every session.
It works alongside `docs/hedgehog-principles.md`, `docs/hedgehog-stack.md`,
`docs/hedgehog-order.md`, and `docs/hedgehog-logic.md`.

The live list of what to build right now is `TODO.md` at repo root. Read
it before starting work. It's thin — a short context blurb plus a checklist
mirroring the phase/step structure below. Checked or unchecked is the only
state it carries.

## Intake (once per project, before step 1 of anything)

Capture exactly two things from the person:

1. **Scope boundary** — what's in, what's explicitly out.
2. **Domain vocabulary** — the nouns and verbs of the problem.

If the person starts describing screens or flows, redirect: that comes in
Phase B, after the backend exists.

## Determine Phase

Before touching any code, know which phase you're in:

- **Bootstrap** — project doesn't exist yet. Run Project Bootstrap (Order,
  steps 1–7).
- **Phase A** — building/extending the backend. Every module in scope
  needs schema → contract → repository → service → controller (→ queue)
  before Phase B starts for any of them.
- **Phase B** — Phase A is closed for the scope in question. Build hooks
  and screens.

To determine which phase you're in: check `TODO.md`, or the commit log for
`feat(domain): api` commits. A module with no such commit is in Phase A.

## The Domain Module Pattern

Every module in scope is the same shape, built in this order:

```
schema      (Drizzle)              — types before data
contract    (Zod / ts-rest)        — the boundary
repository  (port + Drizzle adapter)
service     (domain logic)         — imports only ports
controller  (thin HTTP)
hook        (TanStack Query)       — Phase B only
```

Plus, where an operation genuinely needs async: **queue = port + BullMQ
adapter**, same port/adapter shape as the repository. The service imports
only ports. This is enforced by Nx module boundaries
(`docs/hedgehog-logic.md`).

Every step is hand-built, following this sequence directly. Standard Nx
generators (`@nx/nest`, `@nx/next`, `@nx/expo`, `@nx/js`) scaffold the
app/lib shell where applicable.

## The Loop (every unit of work)

1. **Pick the next step** per Order for the current phase and module, from
   `TODO.md`. One step at a time, in order.
2. **Check the gate.** The prior step compiles and passes tests before
   this one starts.
3. **Build exactly one step.** One schema, one contract, one repository.
4. **Run the gate on your own work**: typecheck, lint, test (mirrors
   lefthook).
5. **Commit** using the exact Conventional Commit format from Order's
   table (`feat(domain): schema`, `feat(domain): api`, etc.).
6. **Check off the corresponding line in `TODO.md`.**
7. **Repeat.**

Each commit batches exactly one step. Each step is built right for what's
known now; a wrong step is fixed forward later via the Correction Protocol.

## Correction Protocol

When a downstream step reveals an upstream step was wrong:

1. Stop what you're doing.
2. Patch the upstream step directly, in place.
3. Fast-forward every dependent step that breaks, each as its own small
   commit.
4. The commit messages are the explanation.
5. Resume the loop where you left off.

## Phase Transition Checks

Before starting Phase B for a module, confirm:

- A `feat(domain): api` commit exists for that module.
- The contract is callable and typed (contract tests pass).

Before starting Phase A for a module, confirm:

- It's inside the stated scope boundary. If it isn't, stop and ask.

## Standing Rules

- Vocabulary, Stack, and Order are the three standing-default docs.
  Everything else is code, config, `TODO.md`, or commit log.
- `TODO.md` and every tracked item carry exactly one state: checked or
  unchecked.
- Frontend code for a module (hook, screen) is built after that module's
  API is committed.
- An operation routes through the queue seam when it has a genuine async
  need (long-running, retries, fan-out).
- Shared config in `packages/config` is the single source; a per-app
  override request is a signal to fix the base config at the source.

## Stop Condition

A build session ends when every module in the current scope has completed
both Phase A and Phase B, or when scope is ambiguous enough that continuing
would mean guessing — in which case, ask one question and wait.
