# Hedgehog: Order

The **Order** standing default — root-first build sequence, mapped onto the
Stack. Applies at two scales: once per project (bootstrap) and once per
domain module (every feature). Same sequence either way.

## Project Bootstrap (once)

1. Nx workspace, `packages/config` (ESLint, Prettier, tsconfig, env schema)
2. `packages/db` — Drizzle client + connection
3. `packages/auth` — Better Auth config
4. `apps/api` — Nest app shell, global guard, Pino
5. `apps/worker` — BullMQ seam (Redis, no consumers yet)
6. `apps/web` — Next shell, TanStack Query provider
7. `apps/mobile` — Expo shell (only if building for mobile)

## Domain Module — Definition

A **domain module = one table.** `users`, `orders`, `order_items` are each
their own module, each carrying the full step sequence below. The schema
is the source of truth for where module boundaries fall.

**Cross-module references are FK-by-ID only.** If `orders.user_id`
references `users`, the `orders` schema holds a plain FK column. The
`orders` repository and service depend only on their own ports; a service
knows related entities only as an ID.

- Need the related row too? Resolve it at the contract/controller layer
  (parallel calls to each module's own endpoint), or join against the other
  module's *schema* directly inside the repository (Drizzle query).
- This keeps every service importing only its own ports, so
  `type:service → onlyDependOnLibsWithTags: ['type:port', 'type:util']`
  (Logic doc) holds uniformly.

A junction table (e.g. `order_items`) is one table, one module. It carries
two FK-by-ID columns instead of one, each resolved the same way as any
other cross-module reference.

**`packages/auth` and `packages/jobs` are infra.** They're built once, at
Bootstrap (steps 1–7 above).

## Domain Module — Backend Steps (Phase A, every module in scope)

Every module in scope goes through these steps before any module gets a
hook or a screen — a horizontal pass across the whole backend.

| # | Step | Lives in | Commit |
|---|---|---|---|
| 1 | Schema | `packages/db` (Drizzle) | `feat(domain): schema` |
| 2 | Contract | `packages/contracts` (Zod via `drizzle-zod` + ts-rest) | `feat(domain): contract` |
| 3 | Repository | `libs/<module>/repository` (port + Drizzle adapter) | `feat(domain): repository` |
| 4 | Service | `libs/<module>/service` (domain logic — imports only ports) | `feat(domain): service` |
| 5 | Controller | `apps/api` (thin HTTP, wires contract → service) | `feat(domain): api` |
| 5a | Queue *(only if needed)* | `apps/worker` (port + BullMQ adapter) | `feat(domain): queue` |

Repeat 1–5(a) for every module in scope. The API is complete, typed, and
callable (Postman/curl/contract tests) before frontend work starts.

## Domain Module — Frontend Steps (Phase B, after Phase A closes for the module's scope)

| # | Step | Lives in | Commit |
|---|---|---|---|
| 6 | Hook | `packages/hooks` (TanStack Query) | `feat(domain): hooks` |
| 7 | Screen | `apps/web` and/or `apps/mobile` | `feat(domain): screen-web` / `feat(domain): screen-mobile` |

Phase B starts once Phase A is done for the scope being built. The
frontend is a pure consumer of an already-finished API.

## Rules

- **Phase A closes before Phase B opens.** Every module in scope has a
  working, tested API before any hook or screen starts. The backend is
  finished before frontend work starts, so the frontend is built against
  a fixed API shape.
- **Sequential within a phase.** A step starts once the one before it
  compiles and passes its tests — the Unit of Work gate, enforced by
  lefthook.
- **Step 5a is conditional.** It's added when an operation genuinely needs
  async (long-running, retries, fan-out) — the normal case has no queue.
- **A wrong step gets fixed at its source.** If Phase B reveals step 1 was
  wrong, patch step 1, fast-forward the affected steps as their own small
  commits — the same correction rule as everywhere else in the discipline.
  The commit log is the explanation.
- **Tests are the gate on every commit** in the sequence.

## Enforcement

Dependency direction in code enforces this order: the service imports no
adapters, so building out of order fails to compile. Each step is
hand-built following this sequence; standard Nx generators scaffold the
app/lib shell where applicable (Stack doc).

Vocabulary, Stack, and Order are the three standing-default documents this
discipline produces. Per-feature decisions, corrections, and rationale
live in code and the commit log.
