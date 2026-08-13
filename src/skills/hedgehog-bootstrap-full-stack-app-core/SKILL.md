---
name: hedgehog-bootstrap-full-stack-app-core
description: Use once, at the start of a new Hedgehog project on the full-stack-app core, before hedgehog-bootstrap's add-on steps, to land the full-stack-app core workspace (Nx, packages/config, packages/db, apps/api, apps/web, and every enforcement file) and verify it's green. Runs as the first move of the `bootstrap` agent, which `planner` invokes automatically after Confirm & Lock. No per-project decisions, no add-on awareness.
---

# Hedgehog Bootstrap — full-stack-app Core

Lands the always-on core of a Hedgehog project — the same four pieces on
every project, regardless of size or which add-ons are on — by copying a
pre-built, pre-verified workspace (`src/golden-cores/full-stack-app/` in the Hedgehog
package) rather than generating it live: Nx workspace + enforcement
config, `packages/db`, `apps/api`, `apps/web`. These pieces are
deterministic — the same commands produce the same output on every
project — so the output is committed once, upstream, and copied here
instead of re-derived by an agent on every run. `hedgehog-bootstrap`
calls this skill first, unconditionally, then continues with its own
add-on steps (Auth, Queue, Mobile) — those genuinely vary per project
and stay live.

This skill has no per-project decisions to make: no Add-ons dependency,
no Add-ons check, nothing to ask. Core is identical on every Hedgehog
project.

## What lands

Everything under `src/golden-cores/full-stack-app/` in the installed Hedgehog package,
copied to the repo root:

- Root: `nx.json`, `pnpm-workspace.yaml`, `package.json` (with the
  `pnpm.overrides.esbuild` pin, `packageManager` field, and a `dev`
  script — `docker compose up -d && nx run-many --target=serve,dev
  --projects=api,web --parallel` — so a fresh clone has one command that
  brings up Postgres and both apps together), `eslint.config.mjs`,
  `docker-compose.yml` (Postgres only — Redis joins later, only if the
  Queue add-on turns on), `.env.example`
  (`DATABASE_URL`/`NODE_ENV`/`WEB_ORIGIN`, copied to `.env` in step 4),
  `lefthook.yml`, `commitlint.config.cjs`,
  `tools/phase-gate.cjs`, `.github/workflows/phase-gate.yml`,
  `tsconfig.base.json`, `pnpm-lock.yaml`.
- `packages/config/` — `eslint-base.js`, `prettier.js` (no
  `prettier-plugin-tailwindcss` — that's `apps/web`'s own config, already
  wired), `env.schema.ts` (core fields only: `DATABASE_URL`, `NODE_ENV`,
  and `WEB_ORIGIN` — the origin `apps/api` enables CORS for, defaulted to
  `apps/web`'s dev origin). Tagged `type:util`.
- `packages/db/` — Drizzle client/connection wired to `loadEnv()`, no
  domain schema. `src/index.ts` re-exports `src/schema/index.ts`, an
  empty barrel-of-barrels a module's `schema` layer adds one re-export
  line to (in that layer's scope — see `core.yaml`). Tagged `scope:db`,
  `type:adapter`.
- `apps/api/` — Nest shell, `nestjs-pino` wired, CORS enabled for
  `WEB_ORIGIN`, health check only, no domain controllers. Vitest wired
  (`vitest.config.mts`, `tsconfig.spec.json` with
  `experimentalDecorators`/`emitDecoratorMetadata` for `Test.createTestingModule`),
  with a smoke test (`app.module.spec.ts`) instantiating `AppModule`.
  `apps/api/src/app/feature-modules.ts` is a generated barrel — see
  **The controller barrel** below — that `AppModule` imports and spreads
  into its `imports`, so no domain module's controller layer ever edits
  `app.module.ts`. Depends on `packages/db` (the controller layer imports
  it by construction). `apps/api-e2e` already converted to Vitest with an
  explicit `e2e` target. Tagged `scope:api`.
- `apps/web/` — `.env.example` (`NEXT_PUBLIC_API_BASE_URL`, copied to
  `apps/web/.env.local` in step 4 — Next loads env files from the app
  directory, so the root `.env` never reaches it; the value carries
  `apps/api`'s `/api` global prefix), Next shell, Tailwind v4 (PostCSS
  plugin, no `tailwind.config.js`), hand-built ShadCN base (`components.json`,
  `cn()` util, CSS variable theme, light/dark toggle via an inline
  pre-hydration script + a client-side `ThemeToggle`), TanStack Query
  provider at the root layout, `prettier-plugin-tailwindcss` scoped to
  its own `.prettierrc.js`. Vitest wired for jsdom (`vitest.config.mts`
  with the `@vitejs/plugin-react` plugin and the `@/*` -> `./src/*` alias
  apps/web/tsconfig.json already declares, `tsconfig.spec.json`,
  `src/test-setup.ts` loading `@testing-library/jest-dom`'s matchers),
  with a smoke test (`theme-toggle.spec.tsx`) rendering and clicking
  `ThemeToggle` via Testing Library. Tagged `scope:web`. `apps/web-e2e`
  (Playwright, scaffolded automatically by `@nx/next:app`) gets its own
  `e2e` target by default — no rename needed, unlike `apps/api-e2e`.
- The full `@nx/enforce-module-boundaries` `depConstraints` list for
  exactly these tags, matching the project shape `core.yaml`'s layer
  sequence actually produces — plus the `no-restricted-imports` rules that
  carry port discipline, which a tag constraint can't express because a
  module's port interface and its Drizzle adapter share one lib
  (`libs/<module>/repository`). `enforceBuildableLibDependency` is off:
  `packages/contracts` and `packages/hooks` are source-only by design, and
  it fails `apps/web` for importing either. `scope:auth`/`scope:worker`/
  `scope:mobile` entries are added live by the matching add-on step in
  `hedgehog-bootstrap`, only if that add-on turns on.
- The `@nx/js/typescript` plugin registration (`typecheck` target) with
  `composite`/`declaration` already set on every `tsconfig.lib.json` /
  `tsconfig.app.json` / `tsconfig.spec.json` this core touches.

`node_modules` is not part of the copy — `pnpm install` regenerates it
from the committed `pnpm-lock.yaml`, which is a fast resolve against a
locked graph, not a fresh solve.

## The controller barrel

`apps/api/src/app/app.module.ts` never takes a per-module edit.
`core.yaml`'s controller layer scope is `apps/api/src/app/{module}/**` —
module-disjoint by construction, so two modules' controller tasks never
touch the same file — but `app.module.ts` itself sits outside every
module's scope, and `src/db/core.mjs`'s `validateCore` rejects a
non-exclusive layer whose scope omits `{module}` on a module-axis core,
so the controller layer's scope can't be widened to include it either. A
file two concurrent module builds both hand-edited would also be
invisible to the scheduler's conflict check (`src/db/conflict.mjs` only
compares each task's own declared scope globs), so even a single shared
line to append to would race undetected.

`apps/api/src/app/feature-modules.ts` solves this by never being
hand-edited at all: `tools/generate-feature-modules.cjs` globs
`apps/api/src/app/*/*.module.ts` and writes it as a generated barrel — a
literal `import { XModule } from './x/x.module'` per domain module found,
plus an exported `featureModules` array — every time the
`generate-feature-modules` Nx target runs. `AppModule` imports that one
generated file and spreads `featureModules` into its own `imports`. A
module's controller layer only ever creates its own `{module}.module.ts`
inside its own `apps/api/src/app/{module}/` directory — always in scope,
never colliding with any other module's controller task. In the shipped
core, no domain module exists yet, so the glob finds nothing and
`feature-modules.ts` exports an empty array.

`generate-feature-modules` is wired as an explicit Nx target on `apps/api`
(`apps/api/package.json`'s `nx.targets`), cached, with `build` declaring
it as a `dependsOn`; `test` and `typecheck` pick it up the same way
through `nx.json`'s `targetDefaults` (a project with no matching target,
such as `db` or `web`, silently skips a missing `dependsOn` entry rather
than failing). Static imports rather than a runtime directory scan:
`apps/api` builds through `NxAppWebpackPlugin`, which bundles by
statically walking `main.ts`'s import graph — a file never reached by a
static `import`/`require` is dropped from the bundle entirely, so a
runtime `fs.readdirSync` scan for sibling files would find nothing in the
built output even though the same scan works when Vitest runs the same
source directly. Generating literal imports keeps both paths identical.

## Steps

### 1. Confirm this hasn't already run

Check for `nx.json` at the repo root, or a prior
`feat(config): workspace + shared config` commit
(`git log --grep="^feat(config): workspace"`). Either means core already
landed — stop, don't re-copy. If something about the landed core seems
wrong, that's a Correction Protocol case (`hedgehog-loop`), not a
re-copy: patch the specific file at its source.

### 2. Confirm Docker is available

`docker --version`. Core's `docker-compose.yml` (Postgres) needs it
immediately after landing, on every host OS — macOS, Windows, Linux
alike. No Docker: stop and point to installing Docker Desktop
(macOS/Windows) or Docker Engine (Linux) rather than falling back to a
natively-installed Postgres. See **Local infra: Docker, always** below.

### 3. Land `src/golden-cores/full-stack-app/`

`hedgehog init --ts-full-stack-app` copies `src/golden-cores/full-stack-app/`
to the repo root at install time, the same way it copies `src/agents` to
this host's own agents directory — check whether the core files are
already present (same check as step 1) before copying again. On a project that ran
plain `init` (no core flag) and only reaches `full-stack-app` because
`planner` picked it at Phase 0, this hasn't happened yet: copy
`src/golden-cores/full-stack-app/`'s contents to the repo root now. Also
merge this core's `CLAUDE.md` section into root `CLAUDE.md`
(`src/templates/CLAUDE.core.full-stack-app.md` fills the shell's
`{{CORE_SECTION}}` placeholder left unfilled by a deferred install) —
skip this if the section is already filled. Either way, by the end of
this step every file listed in "What lands" above should be on disk.

### 4. Install and start local infra

```bash
pnpm install
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
docker compose up -d
```

Two env files, because the two apps load env from different places. The
root `.env` is `apps/api`'s: gitignored and never shipped, with
`.env.example` as the committed template (`DATABASE_URL` matching
`docker-compose.yml`'s Postgres credentials, `NODE_ENV=development`,
`WEB_ORIGIN`). Skipping that copy means `packages/config`'s `loadEnv()`
fails its Zod check the moment `apps/api` boots (`DATABASE_URL` missing) —
a confusing crash to debug live instead of one line here.

`apps/web/.env.local` is Next's, loaded from the app directory rather than
the workspace root, so nothing in the root file reaches the browser.
Skipping that copy is worse than a crash: `NEXT_PUBLIC_API_BASE_URL` comes
back `undefined`, the ts-rest client builds a relative URL, and every hook
404s against Next's own dev server rather than the api — a routing bug in
appearance, an env bug in fact.

`pnpm install` resolves against the committed `pnpm-lock.yaml` — this
should be fast and produce no lockfile changes. A lockfile diff here
means the shipped `pnpm-lock.yaml` doesn't match `package.json` — that's
a packaging bug in `src/golden-cores/full-stack-app`, not something to patch locally
(see **If verification fails**, below).

### 5. Verify

```bash
npx nx run-many -t typecheck,lint,test
npx nx format:write
```

Both must be clean: 0 errors, 0 warnings from the first command; no
diff produced by the second. This is the one live check that replaces
four separate live generate-and-verify passes — core isn't proven
correct by trusting the copy, it's proven correct by actually running
the same gate every other step in this discipline runs.

The commit gate is already active by this point: `lefthook.yml` came
with the copy, and lefthook's own postinstall ran `lefthook install -f`
during step 4's `pnpm install`. Run `pnpm dlx lefthook install` only if
`.git/hooks/pre-commit` is somehow absent.

Confirm the gate is real rather than assuming it, with:

```bash
hedgehog status
```

Its `COMMIT GATE` line reads `active` only when the hooks exist, were
generated with `lefthook.yml`'s `assert_lefthook_installed: true`, and
the lefthook binary actually resolves. Anything else is a gate that
isn't enforcing, and the line names the repair. Two failure modes it
catches that nothing else does: hooks generated before that flag
existed (they fail open — regenerate with `pnpm dlx lefthook install`),
and a `node_modules` that has since been cleared (`pnpm install`).

Also check the hook resolves to the project's pinned local lefthook
(`lefthook version` during a commit, or that `.git/hooks/` resolves
into `node_modules/`) rather than a global Homebrew-installed shadow.

### 6. Commit

```
feat(config): workspace + shared config
```

One commit for all of core, landed as a verified copy. That commit
existing is the record that core landed — `bootstrap` checks for it via
the commit log, not a checklist line.

## Known issues baked into the full-stack-app core

These are already fixed in the committed tree — listed here so anyone
regenerating `src/golden-cores/full-stack-app` (see
`scripts/regenerate-full-stack-app-core.sh`) knows why the tree looks the
way it does, and doesn't reintroduce the
bug by "cleaning up" what looks like an unnecessary pin or directive.

- **`tsconfig.base.json` uses `esnext`/`bundler` module resolution, not
  `nodenext`.** Turbopack (Next 16's dev bundler) can't resolve a
  `nodenext`-style `.js`-extension relative import specifier (`export *
  from './tasks/index.js'` where only `index.ts` exists) across a pnpm
  workspace-package boundary — `apps/web` importing a runtime value
  (not just a type) from `packages/hooks`, `packages/contracts`, or
  `packages/db` 500s with `Module not found`. `bundler` is TypeScript's
  mode for exactly this case and is Next's own tsconfig default; nothing
  in this stack runs raw `tsc` output directly with Node (`apps/api`
  builds via `webpack-cli`, `apps/web` via Next/Turbopack, tests via
  Vitest), so `nodenext`'s stricter runtime-accurate extension
  enforcement isn't load-bearing anywhere here. Every relative import
  specifier across the template is extensionless accordingly — a
  `schema`/`contract`/`hook` layer adding a new barrel re-export must
  match (`export * from './tasks/index'`, not `'./tasks/index.js'`).
- **`packages/db/src/schema/index.ts` needs `export {};`.** It's an
  empty barrel-of-barrels (see the schema layer's scope in `core.yaml`)
  until the first module's schema layer adds a line to it, but a
  comment-only file with zero import/export statements compiles as an
  ambient script, not a module, under `isolatedModules` +
  `declaration`/`composite`. `packages/db/src/index.ts`'s `export *
  from './schema/index'` fails `db:typecheck` (`TS2306: File ... is not
  a module`) without it.
- **`apps/web/package.json` needs `"nx": { "tags": ["scope:web"] }`.**
  `packages/config/eslint-base.js`'s `depConstraints` already defines a
  `sourceTag: 'scope:web'` rule, but `@nx/next:app` doesn't tag the
  project it generates — an untagged project is barred from depending on
  any tagged library at all under `@nx/enforce-module-boundaries`, so
  `apps/web` fails lint on its first import from any workspace package
  without this.
- **`apps/web-e2e/tsconfig.json` needs an explicit `"types": ["node"]`.**
  `@nx/next:app`'s generated Playwright config (`playwright.config.mts`)
  uses `process.env` and `import.meta.dirname`, but the generator's
  `tsconfig.json` for `apps/web-e2e` has no `types` array — unlike
  `apps/api-e2e`'s Vitest config, which explicitly lists `node` among
  its types. Without it, `nx run web-e2e:typecheck` fails with
  `TS2591`/`TS2339` on both. Add `"types": ["node"]` to
  `compilerOptions` there.
- **`prettier-plugin-tailwindcss` must stay pinned to `^0.7.4`, not
  `^0.8.x`.** `0.8.0+` made `parser.preprocess` async, but Prettier core
  calls it synchronously — crashes with `TypeError: e.charAt is not a
  function` on every `.ts`/`.tsx` file, independent of Tailwind config,
  module format, or Nx/pnpm. `0.7.4` fully supports Tailwind v4's
  `tailwindStylesheet` option, so nothing is lost by staying on it.
  Re-check this pin when bumping the plugin.
- **Tailwind v4 needs `tailwindStylesheet` set explicitly in
  `apps/web/.prettierrc.js`.** There's no `tailwind.config.js` for the
  plugin to autodetect under v4 — point it at
  `./src/app/global.css` (the file with `@import 'tailwindcss'`),
  resolved relative to the `.prettierrc.js` file itself.
- **Any component that imports Radix's `Slot` (the `asChild` pattern —
  e.g. `components/ui/button.tsx`) needs `'use client'` as its first
  line, even if a given render path never actually sets `asChild`.**
  `Slot` calls `React.createContext` at module scope, which crashes
  Server Component builds (`TypeError: e.createContext is not a
  function`) purely on import. Verify with a clean `.next`/Nx cache
  (`rm -rf apps/web/.next .nx/cache`) — a warm cache can mask this.
- **`apps/web/package.json` needs `"type": "module"`, same reasoning as
  the root `package.json`** — `apps/web/.prettierrc.js`
  is ESM (`export default`), and without a matching `"type": "module"`
  Node emits a `MODULE_TYPELESS_PACKAGE_JSON` warning on every prettier
  invocation touching that directory.
- **`apps/api`'s dev port defaults to 3333, not 3000.** `apps/web`'s
  `next dev` also defaults to port 3000, and the root `dev` script runs
  both side by side (`nx run-many --target=serve,dev
  --projects=api,web`). If `apps/api/src/main.ts` ever falls back to
  `process.env.PORT || 3000`, whichever process binds the port second
  either crashes or is silently unreachable, and every API call from the
  web client 404s against Next's own dev server instead (Next has no
  matching route, so it serves its catch-all 404 page rather than a
  connection error — easy to mistake for a routing bug in the api
  itself). Keep `apps/api`'s fallback at `3333` and don't let it drift
  back to matching Next's default.
- **`apps/web/vitest.config.mts` needs `environment: 'jsdom'`, the
  `@vitejs/plugin-react` plugin, and the `@/*` -> `./src/*` alias resolved
  explicitly.** `@nx/next:app --unitTestRunner=vitest` generates a
  Node-flavored config with no JSX plugin and no alias resolution — wrong
  for a React app, and Vitest doesn't read `tsconfig.json`'s `paths` on
  its own. `apps/web/src/test-setup.ts` (loading
  `@testing-library/jest-dom/vitest`) is wired as the config's
  `setupFiles` entry so `toBeInTheDocument()` and friends resolve in every
  spec without a per-file import.
- **No `NODE_ENV=production` build-target override needed** (Nx
  23.1.0, Next 16.1.7). Targets are inferred from
  `package.json`/`next.config.js` via the `@nx/next` plugin, with no
  per-app `project.json` to override. If a future Nx/Next bump ever
  produces a dev-mode production build crash
  (`web:build` succeeds but crashes prerendering `/_global-error` with a
  React-internals error), set `NODE_ENV=production` explicitly on
  `apps/web`'s `build` target as the fix.

## If verification fails

A clean copy of `src/golden-cores/full-stack-app` that fails typecheck/lint/test or
needs a lockfile change means the shipped template itself is broken —
not a per-project problem to hand-patch around. Stop and report exactly
what failed (which target, which error). Fixing this means updating
`src/golden-cores/full-stack-app` at its source (via
`scripts/regenerate-full-stack-app-core.sh` in the Hedgehog repo itself)
and shipping a new package version — never patch a consuming project's
copy to route around a broken template and call core done.

## Local infra: Docker, always

Postgres runs through the `docker-compose.yml` this step lands, on
every host OS, regardless of which add-ons a project turns on later.
This isn't a convenience default — it's what makes "clone the repo, run
the stack" mechanically true regardless of who's building. Don't offer
a native-Postgres alternative even if a contributor already has one
running locally for another project. Redis joins the same file only if
the Queue add-on turns on later, in `hedgehog-bootstrap`'s own step —
not here.

## Constraints

- Run once per project, always as `hedgehog-bootstrap`'s first move —
  never invoked on its own by a user.
- No add-on awareness. If a check here ever seems to need
  `.hedgehog/addons.yaml`, that check belongs in `hedgehog-bootstrap`
  instead — this skill's whole point is being identical across every
  project.
- Don't hand-edit any file this step lands to work around a verification
  failure. Fix `src/golden-cores/full-stack-app` at the source instead (see **If
  verification fails**).
- Don't add domain schema, contracts, or any `libs/<module>/*` content —
  that's Phase A, after every Bootstrap box (core and whichever add-ons
  are on) is checked.
- Local Postgres always runs through the copied `docker-compose.yml`, on
  every host OS. Never substitute a natively-installed Postgres, even to
  match a contributor's existing local setup.
