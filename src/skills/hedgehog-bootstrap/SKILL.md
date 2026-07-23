---
name: hedgehog-bootstrap
description: Use once, at the start of a new Hedgehog project, to scaffold Project Bootstrap and wire in the enforcement config that makes the stack and build order mechanically true (Nx boundaries, lefthook, commitlint, env validation, phase gate). Triggers on "bootstrap this project", "set up the hedgehog stack", "scaffold the workspace". Not for per-module work — that's the `hedgehog-loop` skill, one step at a time.
---

# Hedgehog Bootstrap

Scaffolds Project Bootstrap once per project, plus the enforcement config
that makes the stack and build order mechanically true rather than merely
documented. After this runs, `hedgehog-loop` takes over per module, one
step at a time. This skill touches no domain modules — no schema, no
contract, nothing under `libs/<module>/`. That's Phase A, started fresh
after Bootstrap closes.

Run the `nx g` commands below via nrwl's [nx-generate](https://github.com/nrwl/nx-ai-agents-config/tree/main/skills/nx-generate) skill — it dry-runs
and verifies generator flags against the installed Nx version. Run the
`nx run` / `nx affected` commands in Enforcement wiring via
[nx-run-tasks](https://github.com/nrwl/nx-ai-agents-config/tree/main/skills/nx-run-tasks) the same way. The commands below are the spec; those
skills execute it correctly.

## The Stack: core + add-ons

Hedgehog has one non-negotiable **core** — applied to every project that
uses Hedgehog at all, regardless of size — plus a small set of named
**add-ons**, each scaffolded only when Intake's scope boundary (`planner`)
actually calls for it. The core is not "the small version of the stack";
it's the fixed floor. Add-ons are not "extra polish"; each is standing
infra with a real ongoing cost (a service to run, a secret to manage, a
seam to keep idempotent) that a project without the matching need
shouldn't carry.

### Core (every project, no exceptions)

| Layer | Choice |
|---|---|
| Monorepo | Nx |
| Package manager | pnpm |
| Backend framework | NestJS |
| ORM | Drizzle (+ `drizzle-zod`) |
| Database | PostgreSQL |
| Local infra | Docker Compose (Postgres) |
| Platform | Railway |
| API contract | ts-rest |
| Validation | Zod |
| Data fetching / hooks | TanStack Query |
| Web UI | Next.js (frontend only) + ShadCN + Tailwind |
| Logging | Pino (`nestjs-pino`) |
| Lint / format | ESLint (flat config) + Prettier (+ `prettier-plugin-tailwindcss`, scoped to `apps/web`) |
| Testing | Vitest (unit/integration) + Playwright (web e2e) |
| Commits | Conventional Commits + commitlint + lefthook |
| Observability | Sentry |

Constraint-contingent substitutions: Prisma for Drizzle when the team
isn't SQL-comfortable; cloud + Pulumi/SST for Railway when full
declarative IaC is a hard requirement; tRPC for ts-rest when the client is
committed TypeScript-only.

### Add-ons (scaffolded only when Intake calls for them)

Each row is independent — on or off per project, decided at Intake's
Confirm & Lock (`planner`) and recorded in `docs/context.md`. Turning one
on inserts its Bootstrap step(s) into the sequence below; turning it off
means that step is skipped entirely, not stubbed or partially wired.

| Add-on | Trigger (from Intake scope) | Adds |
|---|---|---|
| **Auth** | The product has accounts, logins, or per-user data | Better Auth (+ `@thallesp/nestjs-better-auth`, Drizzle adapter), `packages/auth`, a global auth guard on `apps/api`, `BETTER_AUTH_SECRET` in the env schema |
| **Queue** | At least one operation is genuinely long-running, retried, or fanned out | BullMQ + Redis, `apps/worker`, a `Queue` port/adapter seam, `REDIS_URL` in the env schema, Redis in `docker-compose.yml` |
| **Mobile** | Mobile is explicitly in scope | Expo + React Native Reusables + NativeWind, `apps/mobile` |

A project with none of these on is still a full Hedgehog project — Nx,
NestJS, Postgres, Docker, ts-rest, the phase discipline, and every gate
still apply. What's cut is infra with no consumer, not the discipline
itself.

If a project's whole description has no persistent domain data and no
real lifecycle to model at all (a static marketing page, a one-off
script, a slide deck) — not "small," but literally no state to carry
across a schema/contract/service — Hedgehog doesn't apply. `planner`
checks for this before Intake proper starts (see that agent's opening
check) and says so rather than forcing the discipline onto something with
no domain module in it.

### Monorepo layout

```
apps/
  web        (Next.js — UI only)
  mobile     (Expo — only if the Mobile add-on is on)
  api        (NestJS — owns all domain logic + DB access)
  worker     (BullMQ consumers — only if the Queue add-on is on)

packages/
  db         (Drizzle schema + client)
  contracts  (ts-rest + Zod contracts)
  hooks      (TanStack Query — shared web + mobile)
  jobs       (typed job registry / queue definitions — only if Queue is on)
  auth       (Better Auth config — only if Auth is on)
  config     (locked ESLint/Prettier/tsconfig/env schema)
  shared     (cross-cutting types + utils)

docs/
  design     (<module>.md per module — `ux-planner` agent output)
```

`packages/auth` and `packages/jobs` are infra, built once, here (when
their add-on is on) — not touched again per module. `docs/design` fills in
per module during Phase B; nothing to scaffold here beyond the empty
directory.

### Queue add-on: seam in, usage deferred

When the Queue add-on is on, it goes in as a day-one standing default:
Redis provisioned on Railway, a `worker` app in the monorepo, a `Queue`
port with a BullMQ adapter (same pattern as repositories) — but usage
stays last-responsible-moment even then: an operation goes async only
when it genuinely needs to (long-running work, retries, fan-out).
Services don't know how their results are returned — the enqueue-vs-await
decision lives at the application/controller layer. Workers are
idempotent (at-least-once delivery). A project where nothing meets that
bar doesn't get the seam at all — see the Add-ons table above.

## Before running

Confirm Intake already happened — a scope boundary and domain vocabulary
should exist (`planner` produces these), **and** it should record which
add-ons (Auth, Queue, Mobile) are on for this project — check
`docs/context.md` for an explicit "Add-ons" note. No scope boundary yet,
or a scope boundary with no recorded add-on decision: stop and point to
`planner` rather than guessing which add-ons apply.

Confirm this hasn't already run: check for an existing Nx workspace
(`nx.json` at repo root) or a prior Bootstrap commit
(`git log --grep="^feat(config)"`). Re-running Bootstrap against an
existing workspace is a Correction Protocol case (patch the specific
config step at its source, per `hedgehog-loop`), not a re-scaffold.

If a fresh `pnpm install` in the generated workspace fails on a binary
package's postinstall script with a version-mismatch error (e.g.
"Expected X but got Y" for a native binary like `esbuild`), don't assume
project misconfiguration or a corrupted pnpm store — check **Known issue:
esbuild postinstall version mismatch** below first; this is a known,
deterministic collision, not something to misdiagnose from scratch.

Confirm Docker is available (`docker --version`) before step 1. Local
Postgres runs through Docker Compose on every host OS — see **Local
infra: Docker, always** below — regardless of which add-ons are on. No
Docker installed: stop and point the user to installing Docker Desktop
(macOS/Windows) or Docker Engine (Linux) rather than falling back to a
natively-installed Postgres. (Redis joins the same compose file only if
the Queue add-on is on — see that step.)

## Steps (run in sequence, one commit per step)

### 1. Nx workspace + `packages/config`

The installer has already placed files at the repo root (`.claude/`, the
`CLAUDE.md`/`TODO.md` templates, a minimal root `package.json`, and git).
`create-nx-workspace` refuses a non-empty directory, so scaffold Nx *in
place* instead — `nx init` tolerates the existing files and merges into
them (appends to `.gitignore`, injects an Nx block into `CLAUDE.md` between
marker comments, adds `nx` to the root `package.json`):

```bash
npx nx@latest init
pnpm add -D @nx/js
```

`nx init` needs the root `package.json` the installer dropped — without
one it falls into standalone (`.nx` wrapper) mode instead of a proper
pnpm workspace.

`nx init` does not reliably respect an existing `packageManager: pnpm@...`
field — it can run its own install via npm regardless, leaving a
`package-lock.json` next to the intended `pnpm-lock.yaml`. Immediately
after `nx init` completes, check for `package-lock.json` at the repo
root; if present, delete it and run `pnpm install` to regenerate
`pnpm-lock.yaml` before continuing to step 2. Don't assume `nx init`
respects the locked package manager — verify.

`nx init` also does not create `pnpm-workspace.yaml`. Without it, pnpm
doesn't recognize `packages/*` or `apps/*` as workspace members —
`pnpm add -w` fails with `ERR_PNPM_ADDING_TO_ROOT`-adjacent errors, and
cross-package `pnpm add` for a lib silently installs to the wrong place.
Create it manually right after `nx init`, before the first `pnpm add`:

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

Then generate the first lib. The **first** `@nx/js:lib` call materializes
the whole workspace shape (`tsconfig.base.json`, root `eslint.config.mjs`,
`.prettierrc`, `vitest.workspace.ts`, the `packages/` layout, and the
tsconfig `paths` mapping) — the same scaffolding the `ts` preset would
have produced, generated lazily on first use:

```bash
npx nx g @nx/js:lib packages/config --bundler=none --unitTestRunner=vitest
```

`packages/config` is a plain `@nx/js` lib holding the locked, shared
files:

- `packages/config/eslint-base.js` — flat config, extended by every
  app/lib. Include `@nx/enforce-module-boundaries` and `depConstraints`
  from Enforcement wiring below, verbatim.
- `packages/config/prettier.js` — **don't** add `prettier-plugin-tailwindcss`
  here. The plugin parses every file prettier touches (not just files with
  Tailwind classes) and throws (`TypeError: e.charAt is not a function` /
  `a.startsWith is not a function`) on any file when no Tailwind config is
  resolvable yet — which is every project from step 1 through step 5, since
  Tailwind doesn't arrive until `apps/web` in step 6. Loading it globally
  here breaks `nx format:write` and any bare `prettier --check` for the
  first five steps of every project. Add the plugin to `apps/web`'s own
  prettier setup (extending this base config) once Tailwind exists, not to
  the shared base.
- `packages/config/env.schema.ts` — the Zod env schema from Enforcement
  wiring below. Core fields only: `DATABASE_URL`, `NODE_ENV`.
  `BETTER_AUTH_SECRET` is added only if the Auth add-on is on (step 3);
  `REDIS_URL` only if the Queue add-on is on (step 5). Don't add either
  speculatively — a required env var with no consumer fails `loadEnv()`
  at boot for no reason.
- Root `eslint.config.js` extends `packages/config/eslint-base.js` and
  declares the project tags table below (`scope:*`, `type:*`) as comments
  or a lookup, so every later generator step tags its project correctly.

Root `eslint.config.mjs` is itself ESM (`.mjs`), which surfaces a Node
warning ("Module type of file... is not specified") unless the root
`package.json` declares `"type": "module"`. Setting that is correct and
worth doing — but it changes how Node resolves *every* plain `.js` file
in the repo from CommonJS to ESM by default. Several files later steps
generate are CommonJS (`require`/`module.exports`) and will break with
`ReferenceError: require is not defined` or `module is not defined` the
moment `"type": "module"` is set: `apps/*/webpack.config.js`,
`commitlint.config.js`, and any hand-written CommonJS tool script (e.g.
`tools/phase-gate.js`). Rename each to `.cjs` as it's created (or convert
its content to ESM, as `next.config.js` supports natively via
`export default`) rather than discovering the break later when `nx
graph` or a generator that depends on the project graph fails
opaquely — Nx surfaces this as "Failed to process project graph" pointing
at the offending file, not as a module-system explanation.

Add a root `docker-compose.yml` provisioning Postgres for local dev,
regardless of host OS (macOS, Windows, Linux) — see **Local infra: Docker,
always** below for why this isn't optional. `DATABASE_URL` in `.env`
points at the compose service from the first commit, matching the env
schema below. (If the Queue add-on is on, step 5 adds a `redis` service
and `REDIS_URL` to this same file/env — not here, since Postgres is core
and Redis isn't.)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
    ports:
      - '5432:5432'
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  postgres-data:
```

Add an `esbuild` override to root `package.json` in this step, before step
2 installs `drizzle-kit` — see **Known issue: esbuild postinstall version
mismatch** below for why.

```json
{
  "pnpm": {
    "overrides": { "esbuild": "0.25.12" }
  }
}
```

Commit: `feat(config): workspace + shared config`

### 2. `packages/db` — Drizzle client + connection

```bash
npx nx g @nx/js:lib packages/db --bundler=none --unitTestRunner=vitest
pnpm add drizzle-orm pg && pnpm add -D drizzle-kit drizzle-zod
```

Wire a Postgres connection reading `DATABASE_URL` via `loadEnv()`
(step 1's env schema). No domain schema files yet — that's Phase A, per
module. Tag: `scope:db`, `type:adapter`.

Commit: `feat(db): drizzle client + connection`

### 3. `packages/auth` — Better Auth config *(Auth add-on only)*

Skip this step entirely if Auth isn't on for this project (check
`docs/context.md`'s Add-ons note from Intake) — don't scaffold a
credential store with no login anywhere in scope. If skipped, check its
`TODO.md` line off as skipped-and-confirmed (per the `bootstrap` agent's
handling of conditional steps), same treatment as an out-of-scope
`apps/mobile`.

```bash
npx nx g @nx/js:lib packages/auth --bundler=none --unitTestRunner=vitest
pnpm add better-auth @thallesp/nestjs-better-auth
```

Configure the Drizzle adapter against `packages/db`. Add
`BETTER_AUTH_SECRET: z.string().min(32)` to `packages/config/env.schema.ts`
now (it doesn't exist in the core schema from step 1). Tag: `scope:auth`,
`type:adapter`.

Commit: `feat(auth): better auth config`

### 4. `apps/api` — Nest app shell, Pino (+ global auth guard if Auth is on)

```bash
npx nx g @nx/nest:app apps/api
pnpm add nestjs-pino pino-http
```

Wire `nestjs-pino` for structured logging (always). Call `loadEnv()` at
the top of `apps/api/src/main.ts`. Tag: `scope:api`. No controllers beyond
a health check — domain controllers arrive per module in Phase A.

**If the Auth add-on is on** (step 3 ran): also
`pnpm add @thallesp/nestjs-better-auth` and wire the global auth guard
(secure-by-default) against `packages/auth`. **If Auth is off**: there's
no guard to wire — a bare health check with no auth dependency is
correct, not a gap to fill in later.

`@nx/nest:app` also scaffolds a companion `apps/api-e2e` project wired to
Jest (`jest.config.cts`), not Vitest — inconsistent with the locked stack.
Convert it: delete the Jest config, add a `vitest.config.mts` (mirroring
`packages/db`'s), and give `apps/api-e2e`'s `tsconfig.spec.json` the same
`composite`/`declaration` treatment as above. Rename its target from the
plugin-inferred `test` to an explicit `e2e` — an HTTP e2e suite needs a
live server (`dependsOn: ["api:build", "api:serve"]`), and if it keeps the
default `test` name, `nx affected -t test` (what lefthook's pre-commit
hook runs on every commit, per the Commit gate below) will try to boot a
server on every commit. Exclude `apps/api-e2e` from the `@nx/vitest`
plugin's auto-inference in `nx.json` (`"exclude": ["apps/api-e2e/**"]` on
that plugin entry) so it stops registering a `test` target for this
project at all, keeping only the manually-defined `e2e` target.

Commit: `feat(api): nest shell + pino` (Auth off) or
`feat(api): nest shell + global guard + pino` (Auth on).

### 5. `apps/worker` — BullMQ seam (Redis, no consumers yet) *(Queue add-on only)*

Skip this step entirely if Queue isn't on for this project (check
`docs/context.md`'s Add-ons note) — no operation in scope is
long-running, retried, or fanned out, so there's nothing for a queue to
seam in for. If skipped, check its `TODO.md` line off as
skipped-and-confirmed, same treatment as an out-of-scope `apps/mobile`.

```bash
npx nx g @nx/node:app apps/worker
pnpm add bullmq ioredis
```

Add a `redis` service to the root `docker-compose.yml` from step 1
(Postgres-only until now) and `REDIS_URL: z.string().url()` to
`packages/config/env.schema.ts` (it doesn't exist in the core schema):

```yaml
  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'
    volumes:
      - redis-data:/data
```

(and add `redis-data:` under the top-level `volumes:` key.)

Provision the Redis connection and a `Queue` port shape (port + BullMQ
adapter, same pattern repositories use later) with no consumers — usage
is deferred (see Queue add-on, above). Call `loadEnv()` at the top of
`apps/worker/src/main.ts`. Tag: `scope:worker`.

Commit: `feat(worker): bullmq seam, no consumers`

### 6. `apps/web` — Next shell, TanStack Query provider, base theme

```bash
npx nx g @nx/next:app apps/web
pnpm add @tanstack/react-query
```

**Do not run `pnpm dlx shadcn@latest init` (or `shadcn add`) against
`apps/web` directly.** The shadcn CLI hard-requires a `package.json` in
its target directory to detect the project; an Nx-generated app under
this stack has no per-app `package.json` (dependencies live at the
workspace root). Finding none, the CLI's default behavior is to offer —
and on `--yes`, silently proceed — to scaffold a *brand-new*
`create-next-app` project **inside** `apps/web`, complete with its own
nested `.git`, its own lockfile, and its own `package.json`. This doesn't
error; it succeeds and leaves a corrupted nested project (e.g.
`apps/web/web/`) that has to be manually detected and deleted. There is
currently no supported non-interactive flag that makes shadcn's CLI
target an existing package-json-less directory in place.

Build the base theme by hand instead: write `apps/web/components.json`
directly (style, aliases, `tailwind.css` path — the `css` field), add
`class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, and
`@radix-ui/react-slot` as dependencies, write `apps/web/src/lib/utils.ts`
(the standard `cn()` helper), and hand-write the CSS variable theme block
(light/dark, using shadcn's published default token values) into
`apps/web`'s global stylesheet. Individual components (e.g. `button.tsx`)
can then be hand-written from shadcn's published source for that
component — small, stable, well-known files — rather than fetched via the
CLI. Set the actual palette here, once, rather than leaving placeholder
values for `ui-builder` to inherit unnoticed on the first screen. Light/
dark mode toggle wiring belongs here too, not as a per-screen decision
later.

**This is where `prettier-plugin-tailwindcss` finally gets added** — step
1 deliberately kept it out of the shared `packages/config/prettier.js`
(it throws on any file when no Tailwind config is resolvable, which was
true for every step before this one). Now that `apps/web`'s Tailwind
stylesheet exists, add it scoped to this app only, in a new
`apps/web/.prettierrc.js` that extends the shared base rather than
editing the base itself:

```js
module.exports = {
  ...require('../../packages/config/prettier.js'),
  plugins: ['prettier-plugin-tailwindcss'],
};
```

Don't add the plugin to the shared base after this point either, even
though Tailwind now exists somewhere in the repo — `packages/config`
itself and any non-`apps/web` package still has no Tailwind config to
resolve against, so the same crash reappears for them. The plugin stays
a per-app opt-in, permanently, not just until step 6 completes.

Wire the TanStack Query provider at the root layout (App Router: a
`'use client'` `Providers` wrapper component, since the root layout
itself is a server component). No screens or hooks yet — Phase B doesn't
start until Phase A closes for at least one module. Tag: `scope:web`.

**Set `NODE_ENV` explicitly on the `build` target, or the production
build silently runs in dev mode under Nx.** Nx's task runner sets
`NODE_ENV=development` by default for every task unless a target
overrides it — including a plain `nx:run-commands` target running `next
build`. Next.js's production build pipeline assumes `NODE_ENV=production`;
running it under `development` produces a build that compiles and
appears to succeed on individual pages but crashes prerendering the
auto-generated `/_global-error` route with `TypeError: Cannot read
properties of null (reading 'useContext')` — a React-internals mismatch
from the dev/prod build split, not an app bug. This only reproduces
through `nx run web:build`; the identical `next build --webpack` run
directly from `apps/web` succeeds, because a bare shell has no `NODE_ENV`
set and Next defaults it correctly itself — which makes the symptom look
Nx-specific and environment-related rather than what it is (a task-runner
default silently overriding a value the build assumes). Set it on the
`build` target only, in `apps/web/project.json`:

```json
{
  "targets": {
    "build": {
      "options": {
        "command": "next build --webpack",
        "env": { "NODE_ENV": "production" }
      }
    }
  }
}
```

Leave `dev` alone — it correctly wants `NODE_ENV=development`, which is
also what Nx already defaults it to.

Commit: `feat(web): next shell + query provider + base theme`

### 7. `apps/mobile` — Expo shell *(Mobile add-on only)*

Skip this step entirely if Mobile isn't on for this project (check
`docs/context.md`'s Add-ons note) — don't scaffold speculative infra. If
skipped, check its `TODO.md` line off as skipped-and-confirmed, not left
dangling for a future run to wonder about — same pattern as Auth (step 3)
and Queue (step 5) when their add-on is off.

```bash
npx nx g @nx/expo:app apps/mobile
pnpm add react-native-reusables nativewind
```

Configure NativeWind's theme (`tailwind.config.js` colors, light/dark) to
match `apps/web`'s base theme from step 6 — one visual identity across
platforms, set once here rather than drifting per-screen. Tag:
`scope:mobile`.

Commit: `feat(mobile): expo shell + base theme`

## Enforcement wiring (within step 1, not a separate pass)

These are config *files*, not extra steps — write them as part of step 1
so the commit gate is live before step 2 starts. Every rule below is a
compiler error, lint failure, or blocked commit — this is what makes the
stack and build order mechanically true.

### Nx module boundaries

Encodes "service imports only ports" as a build-time failure.
`@nx/enforce-module-boundaries` reasons at Nx-project granularity, so each
domain module's repository and service are their own Nx lib; `apps/api`
itself is wiring (controllers + module registration) importing those
libs. This makes cross-module isolation (FK-by-ID only, per
`hedgehog-loop`) mechanically true.

**Tags:**

```
apps/api          → scope:api                        (core)
apps/worker        → scope:worker                     (Queue add-on only)
apps/web            → scope:web                       (core)
apps/mobile         → scope:mobile                    (Mobile add-on only)
packages/db          → scope:db,        type:adapter  (core)
packages/contracts   → scope:contracts, type:contract (core)
packages/hooks       → scope:hooks,     type:hook     (core)
packages/auth        → scope:auth,      type:adapter  (Auth add-on only)
packages/shared      → scope:shared,    type:util     (core)
libs/<module>/port      → scope:<module>, type:port
libs/<module>/repository → scope:<module>, type:adapter
libs/<module>/service    → scope:<module>, type:service
```

One `libs/<module>/` triplet per domain module (one table = one module) —
e.g. `libs/orders/port`, `libs/orders/repository`, `libs/orders/service`.
Only add `scope:auth`/`scope:worker`/`scope:mobile` tags, and their
`depConstraints` entries below, if the matching add-on is actually on —
an unused tag with a dangling constraint is exactly the kind of
speculative config this discipline exists to avoid.

**Root `eslint.config.js` rule** (core entries always; add the
Auth/Queue/Mobile lines only if that add-on is on):

```js
'@nx/enforce-module-boundaries': ['error', {
  depConstraints: [
    // domain services never import adapters directly — only ports
    { sourceTag: 'type:service', onlyDependOnLibsWithTags: ['type:port', 'type:util'] },
    // web never imports db or api internals — only contracts + hooks
    { sourceTag: 'scope:web',    onlyDependOnLibsWithTags: ['scope:contracts', 'scope:hooks', 'scope:shared'] },
    // --- Mobile add-on only ---
    { sourceTag: 'scope:mobile', onlyDependOnLibsWithTags: ['scope:contracts', 'scope:hooks', 'scope:shared'] },
    // --- Queue add-on only ---
    // worker only reaches domain logic through ports, same as api
    { sourceTag: 'scope:worker', onlyDependOnLibsWithTags: ['type:port', 'type:util', 'scope:shared'] },
  ],
}],
```

Building out of order (a controller before a service exists, a hook
reaching into `apps/api` directly) fails `nx lint`.

The rule list above is illustrative, not exhaustive — `@nx/enforce-
module-boundaries` denies by default for any project whose tag isn't
named as a `sourceTag` in some `depConstraints` entry ("A project without
tags matching at least one constraint cannot depend on any libraries").
`packages/db` (`scope:db`, `type:adapter`) and `apps/api` (`scope:api`)
both hit this the moment they're generated and tagged in steps 2 and 4,
because neither `type:adapter` nor `scope:api` has an entry above. Add
constraints for every tag combination as it's introduced, not only the
ones in the illustrative list — at minimum `type:adapter` (needs
`type:util`, for `packages/config`) and `scope:api` (needs `type:port`,
`type:service`, `type:util` — never `scope:db` directly; `apps/api`
reaches storage through a module's repository/service, not by importing
`packages/db` itself). If Auth is on, `scope:api` also needs
`scope:auth` added to its allowed dependencies (the global guard imports
`packages/auth` directly — the one deliberate exception to "api reaches
things only through ports," since auth is cross-cutting infra, not a
domain module).

### Typecheck target (required before the commit gate can work)

`lefthook.yml`'s pre-commit below runs `nx affected -t typecheck`, but
`@nx/js:lib` and `@nx/nest:app` don't register a `typecheck` target on
their own — it only exists once the `@nx/js/typescript` plugin is
registered in `nx.json`, added in step 1 alongside the eslint and
vitest plugins:

```json
{
  "plugin": "@nx/js/typescript",
  "options": { "typecheck": { "targetName": "typecheck" } }
}
```

Registering the plugin isn't sufficient on its own, either: `tsc
--build`'s composite-project mode (what the inferred `typecheck` target
actually runs) requires every `tsconfig.lib.json` and `tsconfig.spec.json`
it touches to set `"composite": true` and `"declaration": true`. The
generators don't set these — every `@nx/js:lib` and `@nx/nest:app`
project needs both added by hand to `tsconfig.lib.json` /
`tsconfig.app.json` and `tsconfig.spec.json` right after generation, or
`nx run <proj>:typecheck` fails immediately with `TS5069: Option
'emitDeclarationOnly' cannot be specified without specifying option
'declaration' or option 'composite'`. If a project's spec file imports
from its own lib source (the common case), `tsconfig.spec.json` also
needs an explicit `references` entry pointing at `tsconfig.lib.json`, or
`tsc` reports `TS6307: File '...' is not listed within the file list of
project`. Do this for `packages/config` in step 1 so the pattern is
established before every later step repeats it.

### Commit gate (lefthook + commitlint)

Enforces one coherent change, tested, conventionally committed. Runs on
staged files only — fast regardless of repo size.

**`lefthook.yml`:**

```yaml
pre-commit:
  parallel: true
  commands:
    typecheck:
      glob: "*.{ts,tsx}"
      run: npx nx affected -t typecheck --base=HEAD
    lint:
      glob: "*.{ts,tsx}"
      run: npx nx affected -t lint --base=HEAD
    test:
      glob: "*.{ts,tsx}"
      run: npx nx affected -t test --base=HEAD

commit-msg:
  commands:
    commitlint:
      run: npx commitlint --edit {1}
```

Don't pass `--files={staged_files}` to `nx affected` — `nx affected`
forwards unrecognized args straight through to the underlying target
command (e.g. `eslint .`), so `--files={staged_files}` becomes
`eslint . <path>` and errors on any path that doesn't match eslint's own
glob expectations. `--base=HEAD` (comparing against the last commit) is
what makes `nx affected` scope correctly to a pre-commit hook's staged
changes.

**`commitlint.config.js`:**

```js
module.exports = {
  extends: ['@commitlint/config-conventional'],
};
```

Scope is open — a domain module (`orders`, `users`, ...) or an infra area
(`db`, `contracts`, `auth`, `hooks`, `api`, `worker`, `web`, `mobile`,
`config`). `@commitlint/config-conventional` validates type and subject
case; scope isn't restricted to a fixed list since new modules enter play
throughout a project's life.

A commit that fails typecheck, lint, or test does not happen. A commit
exists once it compiles and passes.

Run `pnpm dlx lefthook install` once `lefthook.yml` exists so the gate is
active from step 2 onward.

A machine with lefthook installed globally (e.g. via Homebrew) on `PATH`
can have that version picked up by the git hook shim instead of the
project's pinned local one, silently running different — possibly
incompatible — behavior. After `lefthook install`, verify the hook is
invoking the local pinned version (check `lefthook version` output during
a commit, or that the hook script under `.git/hooks/` resolves to
`node_modules/.bin/lefthook`) rather than a global shadow.

### Env validation (fail fast)

Types-first extended to config. Boot fails immediately on a missing or
malformed env var.

**`packages/config/env.schema.ts`** — core fields only, written in step 1:

```ts
import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(parsed.error.format());
    process.exit(1);
  }
  return parsed.data;
}
```

Step 3 (Auth, if on) adds `BETTER_AUTH_SECRET: z.string().min(32)`. Step 5
(Queue, if on) adds `REDIS_URL: z.string().url()`. Neither field belongs
in the core schema — a required var with no consumer fails `loadEnv()` at
boot on a project that never needed it.

Called once, at the top of `apps/api/src/main.ts` and, if the Queue
add-on is on, `apps/worker/src/main.ts`.

### Phase gate (CI)

Encodes "Phase A closes before Phase B opens" as a CI check. Blocks a PR
introducing a `feat(<module>): hooks` or `feat(<module>): screen-*` commit
for a module with no prior `feat(<module>): api` commit on the branch. Can
land in step 1's commit or as its own `feat(config): phase gate` commit.

**`.github/workflows/phase-gate.yml` (logic sketch):**

```yaml
- name: Enforce Phase A before Phase B
  run: |
    node tools/phase-gate.js
```

**`tools/phase-gate.js` (logic):**

```
for each commit in PR:
  if commit matches /^feat\(([a-z-]+)\): (hooks|screen-\w+)/:
    module = capture group 1
    fail unless a commit matching /^feat\(<module>\): api/ (module
      substituted in) already exists on main or earlier in this branch
```

### Locked format/lint config

One shared config, extended everywhere:

- `packages/config/eslint-base.js` — flat config, extended by every
  app/lib.
- `packages/config/prettier.js` — the shared base, *without*
  `prettier-plugin-tailwindcss` (see step 1 — it belongs in `apps/web`'s
  own config once Tailwind exists, not the shared base).

A per-app override request signals to fix the base config at the source.

## Local infra: Docker, always

Postgres (core) runs through the `docker-compose.yml` from step 1 on
every project, on every host OS — macOS, Windows, Linux alike, regardless
of which add-ons are on. Redis joins the same file, step 5, only if the
Queue add-on is on. This isn't a convenience default; it's what makes
"clone the repo, run the stack" mechanically true regardless of who's
building. A natively-installed Postgres or Redis (Homebrew, an existing
Windows service, a system package) is a per-machine setup step that isn't
in the commit history and isn't reproducible on the next machine —
exactly the kind of tribal-knowledge dependency Hedgehog's enforcement
exists to remove.

Don't offer a "native install" path as an alternative, even if a
contributor already has Postgres running locally for another project. One
mechanism, every machine: `docker compose up -d` before `pnpm install`,
every time. If Docker genuinely can't run on a target machine, that's a
platform-support gap to raise, not a reason to quietly fall back to a
native install for that one contributor.

## Known issue: esbuild postinstall version mismatch

`@nx/vite` (step 1) declares `esbuild` as an *optional* peer dependency
(`^0.27.0 || ^0.28.0`), while `drizzle-kit` (step 2) pins a hard dependency
on `esbuild@^0.25.4`. pnpm's isolated store correctly keeps both esbuild
majors side by side — but esbuild's own `install.js` resolves its platform
binary (`@esbuild/<platform>`) via **ambient** Node module resolution
rather than a path scoped to its own package instance. With multiple
esbuild majors in the tree, that ambient resolution can walk up and grab a
sibling major's platform binary, hardlinking the wrong version's binary
into a package that still claims a different version number. The result
is a postinstall failure like:

```
Error: Expected "0.28.1" but got "0.25.12"
```

This is deterministic (not registry/store corruption) and reproduces even
from a fully clean pnpm store — it's a real collision in esbuild's install
script when it meets pnpm's multi-version isolation. The fix is the
`pnpm.overrides.esbuild` pin added in step 1 above: collapsing to a single
esbuild version (drizzle-kit's hard-pinned range, since it's non-optional
— `@nx/vite`'s peer is optional and simply goes unfilled) removes the
ambiguity that triggers the bug. If this resurfaces after a stack version
bump, re-check drizzle-kit's current `esbuild` dependency range
(`pnpm view drizzle-kit dependencies.esbuild`) and update the override to
match rather than removing it.

## After Bootstrap

Update `TODO.md`: check off every Bootstrap line now built or explicitly
skipped (Auth/Queue/Mobile steps whose add-on is off get checked as
skipped-and-confirmed, not left unchecked or deleted — a future session
should be able to read `TODO.md` alone and know a step was a deliberate
no rather than unfinished work). Leave Phase A/B sections as-is
(per-module, filled in by `planner` during Intake or when new scope
enters play). Hand off to `hedgehog-loop` — from here, every domain
module goes through Phase A steps 1–5(a) one at a time, gated by
lefthook, each its own commit.

## Constraints

- Run once per project. Not a per-module or per-feature tool.
- Core steps (1, 2, 4, 6) always run. Add-on steps (3 Auth, 5 Queue, 7
  Mobile) run only if `docs/context.md`'s Add-ons note (written by
  `planner` at Intake) turns that add-on on — check off its `TODO.md` line
  as skipped-and-confirmed otherwise, don't leave it dangling.
- Don't add domain schema, contracts, or any `libs/<module>/*` content —
  that's Phase A, started after Bootstrap, one module at a time.
- Don't deviate from the package/library choices above, for whichever
  steps actually run. If a generator or package name changed upstream
  since this was written, verify against current docs before running the
  command — don't substitute a different library. Skipping an add-on
  step whose trigger genuinely isn't in scope is not a deviation; adding
  a library the stack doesn't call for, or dropping one it does, is.
- Each step that runs is its own commit, in order — same unit-of-work
  discipline as every other step in the discipline, even though this is
  infra rather than a domain module.
- Local Postgres always runs through the `docker-compose.yml` from step
  1, on every host OS, regardless of add-ons. Redis joins it only if the
  Queue add-on is on. Never substitute a natively-installed Postgres or
  Redis, even to match a contributor's existing local setup — see
  **Local infra: Docker, always**.
