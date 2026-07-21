# Hedgehog: Stack

The **Stack** standing default — the constant an AI or builder operates
under permanently. One opinionated stack, applied the same way on every
project. Every entry is **principle-mandated** or **decision-killing** (it
removes a recurring per-project argument).

## The Stack

| Layer | Choice | Why it's the hedgehog pick |
|---|---|---|
| Monorepo | **Nx** | Most opinionated; its generators + dep graph *are* the ordered work graph. |
| Package manager | **pnpm** | Fast, strict, monorepo-native. |
| Backend framework | **NestJS** | Imposes one way (modules/DI/controllers→services); ships generators for the root-first layers. |
| ORM | **Drizzle** (+ `drizzle-zod`) | Schema *is* TypeScript. Types are the root step, derived everywhere. |
| Database | **PostgreSQL** | Default relational store. |
| Platform | **Railway** (light config) | Long-lived containers host the whole graph (web + api + worker + Postgres + Redis) under one deploy model, with managed simplicity. |
| API contract | **ts-rest** | Contract-first with Zod (same validation source), REST-shaped + first-class OpenAPI, Nest adapter. Consumable by web, mobile, and non-TS clients — preserves UI-swappability. |
| Validation | **Zod** | One source of runtime + compile-time truth. Derives from Drizzle, feeds contracts and forms. Also validates `process.env` at boot (fail fast). |
| Auth | **Better Auth** (+ `@thallesp/nestjs-better-auth`, Drizzle adapter) | Modern TS-native default; global guard = secure-by-default; user data in your own Postgres; self-hosted, MIT, no lock-in. |
| Data fetching / hooks | **TanStack Query** | The hooks step. Runs in React *and* React Native, so it's genuinely shared across web + mobile. |
| Web UI | **Next.js** (frontend only) + **ShadCN** + **Tailwind** | Next as pure UI consumer (Nest owns the backend). ShadCN is copy-you-own-the-code. |
| Mobile UI (optional) | **Expo** + **React Native Reusables** + **NativeWind** | Same copy-you-own + Tailwind mental model, mobile-native primitives. Added only if building for mobile. |
| Queues / jobs | **BullMQ + Redis** | Seam baked in from day one; usage deferred (see below). |
| Logging | **Pino** (`nestjs-pino`) | Nest-idiomatic structured logging. |
| Lint / format | **ESLint (flat config) + Prettier** (+ `prettier-plugin-tailwindcss`) | Boring, proven, Nx-native. One locked shared config = the opinionation. Prettier handles Tailwind class ordering. |
| Testing | **Vitest** (unit/integration) + **Playwright** (web e2e) | The build→test→commit loop requires this; tests are the status field. |
| Commits | **Conventional Commits** + **commitlint** + **lefthook** | Enforces the Unit of Work default. Lefthook runs typecheck + lint + test on staged files as the commit gate. |
| Observability | **Sentry** | Error tracking across web, mobile, and api from day one. |

## Monorepo Layout

```
apps/
  web        (Next.js — UI only)
  mobile     (Expo — optional)
  api        (NestJS — owns all domain logic + DB access)
  worker     (BullMQ consumers)

packages/
  db         (Drizzle schema + client)
  contracts  (ts-rest + Zod contracts)
  hooks      (TanStack Query — shared web + mobile)
  jobs       (typed job registry / queue definitions)
  auth       (Better Auth config)
  config     (locked ESLint/Prettier/tsconfig/env schema)
  shared     (cross-cutting types + utils)
```

## The Domain Module Pattern (the reusable "skill")

Module boundaries are defined in the Order doc. Every module, whatever its
boundary, is the same shape, built in dependency order:

```
schema      (Drizzle)              — types before data
contract    (Zod / ts-rest)        — the boundary
repository  (port + Drizzle adapter)
service     (domain logic)         — imports only ports
controller  (thin HTTP)
hook        (TanStack Query)
```

Plus, where needed: **queue = port + BullMQ adapter** — the same port/adapter
shape as the repository. Domain logic (the service) depends only on ports.
This is what makes the Order step mechanical to hand-build.

## Queues: Seam In, Usage Deferred

The queue seam is a day-one standing default:

- Redis provisioned on Railway.
- A `worker` app in the monorepo.
- A `Queue` port with a BullMQ adapter (same pattern as repositories).

Usage stays last-responsible-moment: an operation goes async when it
genuinely needs to (long-running work, retries, fan-out). Services don't
know how their results are returned, so the enqueue-vs-await decision
lives at the application/controller layer, where flipping it per-operation
is a local change.

Workers are idempotent (at-least-once delivery). That's the discipline the
seam asks for up front.

## Generators

Standard Nx generators handle app/lib scaffolding — `@nx/nest`, `@nx/next`,
`@nx/expo`, `@nx/js`. Each step's actual content (schema, contract,
repository, service, controller, hook) is hand-built, following the Order
sequence directly.

## Constraint-Contingent Choices

- **Drizzle**, when the team is comfortable in SQL; **Prisma**, when it isn't.
- **Railway**, under managed simplicity; cloud + Pulumi/SST, when full
  declarative IaC is a hard requirement.
- **ts-rest**, preserving mobile / swappable-UI consumption; **tRPC**, when
  the client is committed TypeScript-only.
