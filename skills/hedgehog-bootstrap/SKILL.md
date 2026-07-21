---
name: hedgehog-bootstrap
description: Use once, at the start of a new Hedgehog project, to scaffold Project Bootstrap (Order doc, steps 1-7) and wire in the enforcement config from the Logic doc (Nx boundaries, lefthook, commitlint, env validation, phase gate). Triggers on "bootstrap this project", "set up the hedgehog stack", "scaffold the workspace". Not for per-module work — that's the Loop, one step at a time, not this skill.
---

# Hedgehog Bootstrap

Scaffolds Project Bootstrap exactly once per project — Order's steps 1–7
plus the enforcement config that makes Stack and Order mechanically true
(`docs/hedgehog-logic.md`). After this runs, the Loop
(`docs/hedgehog-operating-instructions.md`) takes over for every module,
one step at a time. This skill does not touch domain modules — no schema,
no contract, nothing under `libs/<module>/`. That's Phase A, started
fresh after Bootstrap closes.

## Before running

Confirm Intake has already happened — a scope boundary and domain
vocabulary should exist (`docs/hedgehog-intake.md`). Bootstrap doesn't
need the vocabulary to scaffold infra, but starting it before Intake is a
sign work is getting ahead of itself. If there's no scope boundary yet,
stop and point back to Intake/`planner`.

Confirm this hasn't already run: check for an existing Nx workspace
(`nx.json` at repo root) or a prior Bootstrap commit
(`git log --grep="^feat(config)"`). Re-running Bootstrap against an
existing workspace is a Correction Protocol case (patch the specific
config step at its source), not a re-scaffold.

## Steps (Order doc, Project Bootstrap — run in this sequence, one commit per step)

### 1. Nx workspace + `packages/config`

```bash
npx create-nx-workspace@latest . --preset=ts --pm=pnpm --nxCloud=skip
```

Then scaffold `packages/config` as a plain `@nx/js` lib holding the
locked, shared files (Logic doc):

- `packages/config/eslint-base.js` — flat config, extended by every
  app/lib. Include the `@nx/enforce-module-boundaries` rule and
  `depConstraints` from Logic verbatim.
- `packages/config/prettier.js` — includes `prettier-plugin-tailwindcss`.
- `packages/config/env.schema.ts` — the Zod env schema from Logic
  (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `REDIS_URL`, `NODE_ENV`; extend
  per project as new infra is added at later Bootstrap steps).
- Root `eslint.config.js` extends `packages/config/eslint-base.js` and
  declares the project tags table from Logic §1 (`scope:*`, `type:*`) as
  comments or a lookup, so every subsequent generator step tags its
  project correctly.

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
`type:adapter`. Per Order, `packages/auth` is infra, built once here —
not touched again per module.

Commit: `feat(auth): better auth config`

### 4. `apps/api` — Nest app shell, global guard, Pino

```bash
npx nx g @nx/nest:app apps/api
pnpm add nestjs-pino pino-http && pnpm add @thallesp/nestjs-better-auth
```

Wire the global auth guard (secure-by-default, per Stack) and
`nestjs-pino` for structured logging. Call `loadEnv()` at the top of
`apps/api/src/main.ts`. Tag: `scope:api`. No controllers beyond a health
check — domain controllers arrive per module in Phase A.

Commit: `feat(api): nest shell + global guard + pino`

### 5. `apps/worker` — BullMQ seam (Redis, no consumers yet)

```bash
npx nx g @nx/node:app apps/worker
pnpm add bullmq ioredis
```

Provision the Redis connection and a `Queue` port shape
(port + BullMQ adapter, same pattern repositories will use later) but no
consumers — usage is deferred per Stack ("seam in, usage deferred"). Call
`loadEnv()` at the top of `apps/worker/src/main.ts`. Tag: `scope:worker`.

Commit: `feat(worker): bullmq seam, no consumers`

### 6. `apps/web` — Next shell, TanStack Query provider

```bash
npx nx g @nx/next:app apps/web
pnpm add @tanstack/react-query
pnpm dlx shadcn@latest init
```

Wire the TanStack Query provider at the root layout. No screens or hooks
yet — Phase B doesn't start until Phase A closes for at least one module.
Tag: `scope:web`.

Commit: `feat(web): next shell + query provider`

### 7. `apps/mobile` — Expo shell (only if mobile is in scope)

Skip this step entirely if mobile isn't in the scope boundary from
Intake — don't scaffold speculative infra.

```bash
npx nx g @nx/expo:app apps/mobile
pnpm add react-native-reusables nativewind
```

Tag: `scope:mobile`.

Commit: `feat(mobile): expo shell`

## Enforcement wiring (Logic doc — do this within step 1, not as a separate pass)

These are config *files*, not extra steps — write them as part of step 1
so the commit gate is live before step 2 even starts:

- `lefthook.yml` — the `pre-commit` (typecheck/lint/test on staged files)
  and `commit-msg` (commitlint) blocks from Logic §2, verbatim.
- `commitlint.config.js` — `@commitlint/config-conventional` plus the
  `scope-enum` from Logic §2 (`domain`, `db`, `contracts`, `auth`,
  `hooks`, `api`, `worker`, `web`, `mobile`, `config`).
- `.github/workflows/phase-gate.yml` + `tools/phase-gate.js` — the Phase A
  before Phase B CI check from Logic §4. Can land in step 1's commit or as
  its own `feat(config): phase gate` commit — either is fine since it's
  infra, not a domain step.
- Run `pnpm dlx lefthook install` once `lefthook.yml` exists so the gate
  is actually active for step 2 onward.

## After Bootstrap

Update `TODO.md`: check off every Bootstrap line that's now built, leave
Phase A/B sections as-is (per-module, filled in by `planner` during
Intake or when new scope enters play). Hand off to the Loop — from here,
every domain module goes through Phase A steps 1–5(a) one at a time,
gated by lefthook, each its own commit.

## Constraints

- Run once per project. Not a per-module or per-feature tool.
- Don't scaffold `apps/mobile` unless mobile is explicitly in scope.
- Don't add domain schema, contracts, or any `libs/<module>/*` content —
  that's Phase A, started after Bootstrap, one module at a time.
- Don't deviate from the package/library choices in Stack. If a generator
  or package name has changed upstream since this skill was written,
  that's a signal to verify against current docs before running the
  command blindly — not license to substitute a different library.
- Each of the 7 steps is its own commit, in order — same Unit of Work
  discipline as every other step in the discipline, even though this is
  infra rather than a domain module.
