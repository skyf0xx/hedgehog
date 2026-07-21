---
name: hedgehog-loop
description: Use for every unit of work once a Hedgehog project is bootstrapped — building one Order step (schema, contract, repository, service, controller, hook, screen), gating it, committing it, and checking it off TODO.md. Triggers on "next step", "build this module", "what's next", or the start of any work session on a bootstrapped project. Also covers the Correction Protocol for fixing a wrong upstream step.
---

# Hedgehog Loop

The operating loop for a bootstrapped Hedgehog project: pick the next step,
build it, gate it, commit it, check it off. `TODO.md` at repo root is the
live list of what to build right now — read it before starting work. It's
thin: a short context blurb plus a checklist mirroring the phase/step
structure below. Checked or unchecked is the only state it carries.

## Determine phase

Before touching any code, know which phase applies to the module in
scope:

- **Phase A** — building or extending the backend. Every module in scope
  needs schema → contract → repository → service → controller (→ queue)
  before Phase B starts for any of them.
- **Phase B** — Phase A is closed for the module in question. Build hooks
  and screens.

Check `TODO.md`, or the commit log for `feat(<module>): api` commits. A
module with no such commit is in Phase A.

## The Domain Module Pattern

A **domain module = one table.** `users`, `orders`, `order_items` are each
their own module, each carrying the full step sequence below. The schema
is the source of truth for where module boundaries fall.

**Cross-module references are FK-by-ID only.** If `orders.user_id`
references `users`, the `orders` schema holds a plain FK column. The
`orders` repository and service depend only on their own ports; a service
knows related entities only as an ID.

- Need the related row too? Resolve it at the contract/controller layer
  (parallel calls to each module's own endpoint), or join against the
  other module's *schema* directly inside the repository (Drizzle query).
- This keeps every service importing only its own ports, so the Nx rule
  `type:service → onlyDependOnLibsWithTags: ['type:port', 'type:util']`
  holds uniformly (wired during bootstrap).

A junction table (e.g. `order_items`) is one table, one module. It carries
two FK-by-ID columns instead of one, each resolved the same way as any
other cross-module reference.

Every module goes through the same shape, in this order:

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
only ports.

Standard Nx generators (`@nx/nest`, `@nx/next`, `@nx/expo`, `@nx/js`)
scaffold the app/lib shell where applicable. Every step's actual content
(schema, contract, repository, service, controller, hook) is hand-built,
following this sequence directly.

## Domain Module — Backend Steps (Phase A, every module in scope)

Every module in scope goes through these steps before any module gets a
hook or a screen — a horizontal pass across the whole backend.

| # | Step | Lives in | Commit |
|---|---|---|---|
| 1 | Schema | `packages/db` (Drizzle) | `feat(<module>): schema` |
| 2 | Contract | `packages/contracts` (Zod via `drizzle-zod` + ts-rest) | `feat(<module>): contract` |
| 3 | Repository | `libs/<module>/repository` (port + Drizzle adapter) | `feat(<module>): repository` |
| 4 | Service | `libs/<module>/service` (domain logic — imports only ports) | `feat(<module>): service` |
| 5 | Controller | `apps/api` (thin HTTP, wires contract → service) | `feat(<module>): api` |
| 5a | Queue *(only if needed)* | `apps/worker` (port + BullMQ adapter) | `feat(<module>): queue` |

Repeat 1–5(a) for every module in scope. The API is complete, typed, and
callable (Postman/curl/contract tests) before frontend work starts.

## Domain Module — Frontend Steps (Phase B, after Phase A closes for the module's scope)

| # | Step | Lives in | Commit |
|---|---|---|---|
| 6 | Hook | `packages/hooks` (TanStack Query) | `feat(<module>): hooks` |
| 6a | UX rationale | n/a — read-only, `ux-planner` agent | none — input to step 7, not a committed step |
| 7 | Screen | `apps/web` and/or `apps/mobile` | `feat(<module>): screen-web` / `feat(<module>): screen-mobile` |

Phase B starts once Phase A is done for the scope being built. The
frontend is a pure consumer of an already-finished API. Step 6a is where
the "how it should feel" that Intake deferred gets decided — once, per
module, after the hook exists and before `ui-builder` starts the screen
— via the `ux-planner` agent. It produces a short rationale, not a
commit; `TODO.md` still only tracks hooks/screen-web/screen-mobile per
module.

## The Loop (every unit of work)

1. **Pick the next step** per the tables above for the current phase and
   module, from `TODO.md`. One step at a time, in order.
2. **Check the gate.** The prior step compiles and passes tests before
   this one starts.
3. **Build exactly one step.** One schema, one contract, one repository.
4. **Run the gate on your own work**: typecheck, lint, test (mirrors
   lefthook — wired during bootstrap).
5. **Commit** using the exact Conventional Commit format from the tables
   above.
6. **Check off the corresponding line in `TODO.md`.**
7. **Repeat.**

Each commit batches exactly one step. Each step is built right for what's
known now; a wrong step is fixed forward later via the Correction
Protocol.

## Correction Protocol

When a downstream step reveals an upstream step was wrong:

1. Stop what you're doing.
2. Patch the upstream step directly, in place.
3. Fast-forward every dependent step that breaks, each as its own small
   commit.
4. The commit messages are the explanation.
5. Resume the loop where you left off.

Use the `conventional-commits` skill when a correction touches several
steps in one working-tree pass and they need splitting back into
per-step commits.

## Phase Transition Checks

Before starting Phase B for a module, confirm:

- A `feat(<module>): api` commit exists for that module.
- The contract is callable and typed (contract tests pass).

Use the `reviewer` agent for this check — it looks at what the mechanical
gate can't (port discipline, FK-by-ID discipline, contract shape).

Before starting Phase A for a module, confirm it's inside the stated
scope boundary from Intake (the `planner` agent). If it isn't, stop and
ask.

## Rules

- **Phase A closes before Phase B opens.** Every module in scope has a
  working, tested API before any hook or screen starts.
- **Sequential within a phase.** A step starts once the one before it
  compiles and passes its tests.
- **Step 5a is conditional.** Added only when an operation genuinely
  needs async (long-running, retries, fan-out) — the normal case has no
  queue.
- **A wrong step gets fixed at its source** — the Correction Protocol,
  above, not a workaround downstream.
- **Tests are the gate on every commit** in the sequence.
- Frontend code for a module (hook, screen) is built after that module's
  API is committed.
- The screen step doesn't start from a blank slate — `ux-planner` runs
  once per module, after the hook is committed, before `ui-builder`
  starts the screen.
- Shared config in `packages/config` is the single source; a per-app
  override request is a signal to fix the base config at the source.

## Stop Condition

A build session ends when every module in the current scope has completed
both Phase A and Phase B, or when scope is ambiguous enough that
continuing would mean guessing — in which case, ask one question and
wait.
