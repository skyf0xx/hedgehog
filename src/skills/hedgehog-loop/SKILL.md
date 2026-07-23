---
name: hedgehog-loop
description: Use for every unit of work once a Hedgehog project is bootstrapped — building one Order step (schema, contract, repository, service, controller, hook, screen), gating it, committing it, and checking it off TODO.md. Triggers on "next step", "build this module", "what's next", or the start of any work session on a bootstrapped project. Also covers the Correction Protocol for fixing a wrong upstream step.
---

# Hedgehog Loop

The operating loop for a bootstrapped Hedgehog project: pick the next step,
build it, gate it, commit it, check it off. `TODO.md` at repo root is the
live list — read it before starting. It's thin: a context blurb plus a
checklist mirroring the phase/step structure below. Checked/unchecked is
its only state.

## Determine phase

Before touching code, know which phase applies to the module in scope:

- **Phase A** — building/extending the backend. Every module in scope
  needs schema → contract → repository → service → controller (→ queue)
  before Phase B starts for any of them.
- **Phase B** — Phase A is closed for the module. Build hooks and screens.

Check `TODO.md`, or the commit log for `feat(<module>): api` commits. No
such commit means the module is in Phase A.

## The Domain Module Pattern

A **domain module = one table.** `users`, `orders`, `order_items` are each
their own module, carrying the full step sequence below. The schema is the
source of truth for module boundaries.

**Cross-module references are FK-by-ID only.** If `orders.user_id`
references `users`, the `orders` schema holds a plain FK column. The
`orders` repository and service depend only on their own ports — a service
knows related entities only as an ID.

- Need the related row? Resolve it at the contract/controller layer
  (parallel calls to each module's own endpoint), or join against the
  other module's *schema* directly inside the repository (Drizzle query).
- This keeps every service importing only its own ports, so the Nx rule
  `type:service → onlyDependOnLibsWithTags: ['type:port', 'type:util']`
  holds uniformly (wired at bootstrap).

A junction table (e.g. `order_items`) is one table, one module, with two
FK-by-ID columns instead of one, each resolved the same way.

Every module goes through the same shape, in order:

```
schema      (Drizzle)              — types before data
contract    (Zod / ts-rest)        — the boundary
repository  (port + Drizzle adapter)
service     (domain logic)         — imports only ports
controller  (thin HTTP)
hook        (TanStack Query)       — Phase B only
```

Plus, when an operation needs async **and the Queue add-on is on for this
project** (check `TODO.md`'s `## Add-ons` block): **queue = port +
BullMQ adapter**, same port/adapter shape as the repository. The service
imports only ports. If the Queue add-on is off, there's no `apps/worker`
and no queue step, full stop — an operation that seems to want async
processing on a Queue-off project is a signal to revisit that add-on
decision with `planner`, not to build a one-off queue outside the
add-on's scaffolding.

Standard Nx generators (`@nx/nest`, `@nx/next`, `@nx/expo`, `@nx/js`)
scaffold the app/lib shell. Each step's actual content (schema, contract,
repository, service, controller, hook) is hand-built, following this
sequence.

## Domain Module — Backend Steps (Phase A, every module in scope)

A horizontal pass across the whole backend — every module goes through
these before any module gets a hook or screen.

| # | Step | Lives in | Commit |
|---|---|---|---|
| 1 | Schema | `packages/db` (Drizzle) | `feat(<module>): schema` |
| 2 | Contract | `packages/contracts` (Zod via `drizzle-zod` + ts-rest) | `feat(<module>): contract` |
| 3 | Repository | `libs/<module>/repository` (port + Drizzle adapter) | `feat(<module>): repository` |
| 4 | Service | `libs/<module>/service` (domain logic — imports only ports) | `feat(<module>): service` |
| 5 | Controller | `apps/api` (thin HTTP, wires contract → service) | `feat(<module>): api` |
| 5a | Queue *(if needed, and only if the Queue add-on is on)* | `apps/worker` (port + BullMQ adapter) | `feat(<module>): queue` |

Repeat 1–5(a) per module in scope. The API is complete, typed, and
callable (Postman/curl/contract tests) before frontend work starts.

## Domain Module — Frontend Steps (Phase B, after Phase A closes for the module)

| # | Step | Lives in | Commit |
|---|---|---|---|
| 6 | Hook | `packages/hooks` (TanStack Query) | `feat(<module>): hooks` |
| 6a | UX rationale | `docs/design/<module>.md`, `ux-planner` agent | bundled into step 7's commit |
| 7 | Screen | `apps/web` and/or `apps/mobile` | `feat(<module>): screen-web` / `feat(<module>): screen-mobile` |

Phase B starts once Phase A is done for the scope. The frontend is a pure
consumer of an already-finished API. Step 6a is where "how it should feel"
gets decided — once per module, after the hook exists and before
`ui-builder` starts the screen — via `ux-planner`, starting from whatever
`planner` filed in `docs/design/<module>-notes.md` at Intake. Its first run
for a module also signals to the user that Phase B has started, and is the
point a mockup, screenshot, or export (Google Stitch, Figma) can be handed
over. It writes `docs/design/<module>.md`, not its own step commit;
`TODO.md` tracks only hooks/screen-web/screen-mobile per module.

## The Loop (every unit of work)

1. **Pick the next step** per the tables above, from `TODO.md`. One step
   at a time, in order.
2. **Check the gate.** The prior step compiles and passes tests first.
3. **Build exactly one step.** One schema, one contract, one repository.
4. **Run the gate on your own work**: typecheck, lint, test (mirrors
   lefthook, wired at bootstrap).
5. **Commit** using the exact Conventional Commit format above.
6. **Check off the line in `TODO.md`.**
7. **Repeat.**

Each commit batches exactly one step, built right for what's known now; a
wrong step is fixed forward later via the Correction Protocol.

## Intra-step conventions

The Nx boundaries, phase gate, and lint own the *structural* rules
(what imports what, what gets built when). These are the conventions
*inside* a step that those gates can't see — apply them uniformly so a
fresh-context session builds module N the same way it built module 1. The
`reviewer` agent checks these at a phase boundary.

- **Errors are thrown, typed, and domain-named.** A service throws a
  domain error (`OrderNotFoundError`, not a bare `Error` or an HTTP
  exception) — services don't know they're behind HTTP. The controller is
  the only layer that maps domain errors to status codes. Never return
  `null`/`undefined` to signal a failure a caller must branch on.
- **Repository not-found returns `undefined`; the service decides.** A
  `findById` that misses returns `undefined` (a plain absence, not an
  error); the service turns that into a thrown domain error when the
  operation requires the row. Adapters don't throw domain errors — they
  report absence, the service interprets it.
- **Validation lives at the contract boundary, once.** Input is
  Zod-validated at the controller via the ts-rest contract. Past that
  boundary, types are trusted — services and repositories don't re-parse.
  A service-level invariant that isn't expressible in the Zod schema
  (e.g. "can't cancel after payment") is enforced in the service as a
  thrown domain error, not a second validation pass.
- **Multi-write operations are transactional.** A service method that
  writes more than once wraps the writes in one Drizzle transaction,
  passed through the port — partial writes never escape a failed
  operation.
- **Services are pure domain logic.** No logging, no HTTP, no queue
  mechanics inside a service method — those live at the controller /
  adapter edge. A service reads as the business rule and nothing else.

## Correction Protocol

When a downstream step reveals an upstream step was wrong:

1. Stop.
2. Patch the upstream step directly, in place.
3. Fast-forward every dependent step that breaks, each its own small
   commit.
4. The commit messages are the explanation.
5. Resume the loop.

Use `conventional-commits` when a correction touches several steps in one
working-tree pass and needs splitting back into per-step commits.

## Phase Transition Checks

Before starting Phase B for a module, confirm:

- A `feat(<module>): api` commit exists for that module.
- The contract is callable and typed (contract tests pass).

Use the `reviewer` agent for this — it checks what the mechanical gate
can't (port discipline, FK-by-ID discipline, contract shape).

Before starting Phase A for a module, confirm it's inside the stated scope
boundary from Intake (`planner`). If not, stop and ask.

## Rules

- **Phase A closes before Phase B opens.** Every module in scope has a
  working, tested API before any hook or screen starts.
- **Sequential within a phase.** A step starts once the one before it
  compiles and passes tests.
- **Step 5a is conditional twice over** — only if the Queue add-on is on
  for this project at all (per `TODO.md`'s `## Add-ons` block), and even
  then only when a given operation genuinely needs async (long-running,
  retries, fan-out); the normal case has no queue.
- **A wrong step gets fixed at its source** — the Correction Protocol, not
  a downstream workaround.
- **Tests gate every commit** in the sequence.
- A module's frontend code (hook, screen) is built after its API is
  committed.
- The screen step doesn't start blank — `ux-planner` runs once per module,
  after the hook is committed, before `ui-builder` starts the screen.
- `packages/config` is the single source for shared config; a per-app
  override request signals to fix the base config at the source.

## Stop Condition

A build session ends when every module in scope has completed both Phase
A and Phase B, or when scope is ambiguous enough that continuing means
guessing — ask one question and wait.
