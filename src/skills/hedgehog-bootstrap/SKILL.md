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

## The Stack (locked)

One opinionated stack, applied the same way on every project:

| Layer | Choice |
|---|---|
| Monorepo | Nx |
| Package manager | pnpm |
| Backend framework | NestJS |
| ORM | Drizzle (+ `drizzle-zod`) |
| Database | PostgreSQL |
| Platform | Railway |
| API contract | ts-rest |
| Validation | Zod |
| Auth | Better Auth (+ `@thallesp/nestjs-better-auth`, Drizzle adapter) |
| Data fetching / hooks | TanStack Query |
| Web UI | Next.js (frontend only) + ShadCN + Tailwind |
| Mobile UI (optional) | Expo + React Native Reusables + NativeWind |
| Queues / jobs | BullMQ + Redis |
| Logging | Pino (`nestjs-pino`) |
| Lint / format | ESLint (flat config) + Prettier (+ `prettier-plugin-tailwindcss`) |
| Testing | Vitest (unit/integration) + Playwright (web e2e) |
| Commits | Conventional Commits + commitlint + lefthook |
| Observability | Sentry |

Constraint-contingent substitutions: Prisma for Drizzle when the team
isn't SQL-comfortable; cloud + Pulumi/SST for Railway when full
declarative IaC is a hard requirement; tRPC for ts-rest when the client is
committed TypeScript-only.

### Monorepo layout

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

docs/
  design     (<module>.md per module — `ux-planner` agent output)
```

`packages/auth` and `packages/jobs` are infra, built once, here — not
touched again per module. `docs/design` fills in per module during
Phase B; nothing to scaffold here beyond the empty directory.

### Queues: seam in, usage deferred

The queue seam is a day-one standing default: Redis provisioned on
Railway, a `worker` app in the monorepo, a `Queue` port with a BullMQ
adapter (same pattern as repositories). Usage stays last-responsible-
moment: an operation goes async only when it genuinely needs to
(long-running work, retries, fan-out). Services don't know how their
results are returned — the enqueue-vs-await decision lives at the
application/controller layer. Workers are idempotent (at-least-once
delivery).

## Before running

Confirm Intake already happened — a scope boundary and domain vocabulary
should exist (`planner` produces these). Bootstrap doesn't need the
vocabulary to scaffold infra, but starting before Intake signals work
getting ahead of itself. No scope boundary yet: stop and point to
`planner`.

Confirm this hasn't already run: check for an existing Nx workspace
(`nx.json` at repo root) or a prior Bootstrap commit
(`git log --grep="^feat(config)"`). Re-running Bootstrap against an
existing workspace is a Correction Protocol case (patch the specific
config step at its source, per `hedgehog-loop`), not a re-scaffold.

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
- `packages/config/prettier.js` — includes `prettier-plugin-tailwindcss`.
- `packages/config/env.schema.ts` — the Zod env schema from Enforcement
  wiring below (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `REDIS_URL`,
  `NODE_ENV`; extend per project as new infra is added later).
- Root `eslint.config.js` extends `packages/config/eslint-base.js` and
  declares the project tags table below (`scope:*`, `type:*`) as comments
  or a lookup, so every later generator step tags its project correctly.

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

### 3. `packages/auth` — Better Auth config

```bash
npx nx g @nx/js:lib packages/auth --bundler=none --unitTestRunner=vitest
pnpm add better-auth @thallesp/nestjs-better-auth
```

Configure the Drizzle adapter against `packages/db`. Tag: `scope:auth`,
`type:adapter`.

Commit: `feat(auth): better auth config`

### 4. `apps/api` — Nest app shell, global guard, Pino

```bash
npx nx g @nx/nest:app apps/api
pnpm add nestjs-pino pino-http && pnpm add @thallesp/nestjs-better-auth
```

Wire the global auth guard (secure-by-default) and `nestjs-pino` for
structured logging. Call `loadEnv()` at the top of `apps/api/src/main.ts`.
Tag: `scope:api`. No controllers beyond a health check — domain
controllers arrive per module in Phase A.

Commit: `feat(api): nest shell + global guard + pino`

### 5. `apps/worker` — BullMQ seam (Redis, no consumers yet)

```bash
npx nx g @nx/node:app apps/worker
pnpm add bullmq ioredis
```

Provision the Redis connection and a `Queue` port shape (port + BullMQ
adapter, same pattern repositories use later) with no consumers — usage
is deferred (see Queues, above). Call `loadEnv()` at the top of
`apps/worker/src/main.ts`. Tag: `scope:worker`.

Commit: `feat(worker): bullmq seam, no consumers`

### 6. `apps/web` — Next shell, TanStack Query provider, base theme

```bash
npx nx g @nx/next:app apps/web
pnpm add @tanstack/react-query
pnpm dlx shadcn@latest init
```

Wire the TanStack Query provider at the root layout. `shadcn init` writes
`apps/web`'s base theme (CSS variables for color, radius, light/dark
mode) — set the actual palette here, once, rather than leaving ShadCN's
placeholder values for `ui-builder` to inherit unnoticed on the first
screen. Light/dark mode toggle wiring belongs here too, not as a
per-screen decision later. No screens or hooks yet — Phase B doesn't
start until Phase A closes for at least one module. Tag: `scope:web`.

Commit: `feat(web): next shell + query provider + base theme`

### 7. `apps/mobile` — Expo shell (only if mobile is in scope)

Skip entirely if mobile isn't in the scope boundary from Intake — don't
scaffold speculative infra.

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
apps/api          → scope:api
apps/worker        → scope:worker
apps/web            → scope:web
apps/mobile         → scope:mobile
packages/db          → scope:db,        type:adapter
packages/contracts   → scope:contracts, type:contract
packages/hooks       → scope:hooks,     type:hook
packages/auth        → scope:auth,      type:adapter
packages/shared      → scope:shared,    type:util
libs/<module>/port      → scope:<module>, type:port
libs/<module>/repository → scope:<module>, type:adapter
libs/<module>/service    → scope:<module>, type:service
```

One `libs/<module>/` triplet per domain module (one table = one module) —
e.g. `libs/orders/port`, `libs/orders/repository`, `libs/orders/service`.

**Root `eslint.config.js` rule:**

```js
'@nx/enforce-module-boundaries': ['error', {
  depConstraints: [
    // domain services never import adapters directly — only ports
    { sourceTag: 'type:service', onlyDependOnLibsWithTags: ['type:port', 'type:util'] },
    // web/mobile never import db or api internals — only contracts + hooks
    { sourceTag: 'scope:web',    onlyDependOnLibsWithTags: ['scope:contracts', 'scope:hooks', 'scope:shared'] },
    { sourceTag: 'scope:mobile', onlyDependOnLibsWithTags: ['scope:contracts', 'scope:hooks', 'scope:shared'] },
    // worker only reaches domain logic through ports, same as api
    { sourceTag: 'scope:worker', onlyDependOnLibsWithTags: ['type:port', 'type:util', 'scope:shared'] },
  ],
}],
```

Building out of order (a controller before a service exists, a hook
reaching into `apps/api` directly) fails `nx lint`.

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
      run: npx nx affected -t typecheck --files={staged_files}
    lint:
      glob: "*.{ts,tsx}"
      run: npx nx affected -t lint --files={staged_files}
    test:
      glob: "*.{ts,tsx}"
      run: npx nx affected -t test --files={staged_files}

commit-msg:
  commands:
    commitlint:
      run: npx commitlint --edit {1}
```

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

### Env validation (fail fast)

Types-first extended to config. Boot fails immediately on a missing or
malformed env var.

**`packages/config/env.schema.ts`:**

```ts
import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  REDIS_URL: z.string().url(),
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

Called once, at the top of `apps/api/src/main.ts` and
`apps/worker/src/main.ts`.

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
- `packages/config/prettier.js` — includes `prettier-plugin-tailwindcss`.

A per-app override request signals to fix the base config at the source.

## After Bootstrap

Update `TODO.md`: check off every Bootstrap line now built, leave Phase
A/B sections as-is (per-module, filled in by `planner` during Intake or
when new scope enters play). Hand off to `hedgehog-loop` — from here,
every domain module goes through Phase A steps 1–5(a) one at a time,
gated by lefthook, each its own commit.

## Constraints

- Run once per project. Not a per-module or per-feature tool.
- Don't scaffold `apps/mobile` unless mobile is explicitly in scope.
- Don't add domain schema, contracts, or any `libs/<module>/*` content —
  that's Phase A, started after Bootstrap, one module at a time.
- Don't deviate from the package/library choices above. If a generator or
  package name changed upstream since this was written, verify against
  current docs before running the command — don't substitute a different
  library.
- Each of the 7 steps is its own commit, in order — same unit-of-work
  discipline as every other step in the discipline, even though this is
  infra rather than a domain module.
