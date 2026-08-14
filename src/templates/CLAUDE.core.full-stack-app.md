## This project's core: full-stack-app

Backend-first, schema → contract → repository → service → controller, then
hook → UX rationale → screen, per domain module. See `.hedgehog/BMAD/` for
the archival planning intake output — BMAD-METHOD's brainstorming, brief,
PRD, and UX spec, written once by `planner` and never edited after. Its
`00-manifest.md` records which intake mode produced it; a compressed
archive holds the PRD and whatever flows the brief stated, and nothing
else.
`.hedgehog/addons.yaml` carries this core's Add-ons decision
(Auth/Queue/Mobile, each on or off) — check it before assuming any
add-on's infra exists.

### The skills — invoke these, don't improvise

The discipline is packaged as skills. Use them; don't reconstruct their
steps from memory:

- **`hedgehog-loop`** — every unit of work once bootstrapped: `hedgehog
  next` emits the packet for one ready layer, build exactly one, gate it
  via `hedgehog verify`, which commits it on a pass. Also holds the
  Correction Protocol for fixing a wrong upstream step. Invoke it at the
  start of any build session and for "what's next".
- **`hedgehog-bootstrap`** — run **once**, at project start, to scaffold
  the core stack, the enforcement config, and whichever add-ons (Auth,
  Queue, Mobile) planning intake turned on. Skip if `nx.json` already
  exists.
- **`conventional-commits`** — when a change spans several steps in one
  working-tree pass and needs splitting back into per-step commits (mainly
  Correction Protocol cleanups).

### The agents — delegate the judgment calls

- **`planner`** — planning intake (which core applies, then
  `hedgehog-planning-intake`'s BMAD-METHOD brainstorming/brief/PRD/UX-spec
  shelf, mined into intent records, the Add-ons decision, and domain
  vocabulary) at project start. Writes intents via `hedgehog intent add`,
  `.hedgehog/addons.yaml`, and `.hedgehog/BMAD/`. On first run, hands off
  to the `bootstrap` agent once Confirm & Lock holds. Runs again whenever
  new scope enters play — including after the build is complete — taking
  `hedgehog-planning-intake`'s **Re-entry pass**: the BMAD shelf and
  `bootstrap` are both skipped, new modules are mined into additional
  intents, and `hedgehog plan` appends their tasks without touching
  anything already built.
- **`bootstrap`** — runs `hedgehog-bootstrap`'s core steps (always) plus
  whichever add-on steps planning intake turned on. Triggered
  automatically by `planner` after its first run; skip if `nx.json`
  already exists.
- **`backend-eng`** — builds each module's Phase A layers (schema →
  contract → repository → service → controller → queue?), one
  `hedgehog next` packet at a time, gated by `hedgehog verify`.
- **`ux-planner`** — once per module in Phase B, after the hook exists and
  before the screen: writes `docs/design/<module>.md`, reading
  `.hedgehog/BMAD/05-ux-spec/` directly (or
  `docs/design/<module>-notes.md` if a prior run already filed one). Where
  the archive holds no UX spec, it asks for visual input rather than
  inferring a direction.
- **`front-end-eng`** — builds each module's Phase B layers (hook, screen)
  from the ux-planner rationale, one `hedgehog next` packet at a time,
  gated by `hedgehog verify`.
- **`reviewer`** — phase-transition and Correction Protocol checks the
  mechanical gate can't make (port discipline, FK-by-ID discipline,
  contract shape).

## The constants (do not deviate)

### Stack: core (locked, every project) + add-ons (this project's picks below)

**Core** — applies regardless of project size or which add-ons are on:
Nx monorepo · pnpm · **NestJS** (all domain logic + DB access) · **Drizzle**
(+ `drizzle-zod`) · **PostgreSQL** · **Docker Compose** (local Postgres,
every host OS) · Railway · **ts-rest** contracts · **Zod** validation ·
**TanStack Query** hooks · **Next.js** + ShadCN + Tailwind (web, UI only) ·
Pino logging · Vitest + Playwright (tests) · Conventional Commits +
commitlint + lefthook · Sentry.

**Add-ons** — each on or off per project, decided at planning intake and
recorded in `.hedgehog/addons.yaml`; check that file for this project's
actual picks rather than assuming any of these are present:

| Add-on | Adds |
| --- | --- |
| Auth | Better Auth, `packages/auth`, a global auth guard on `apps/api` |
| Queue | BullMQ + Redis, `apps/worker`, a `Queue` port/adapter seam |
| Mobile | Expo + React Native Reusables + NativeWind, `apps/mobile` |

An add-on that's off means the corresponding piece of infra genuinely
isn't in this codebase — don't write code assuming `packages/auth`,
`apps/worker`, or `apps/mobile` exist without checking
`.hedgehog/addons.yaml` first.

Don't substitute libraries, in core or in whichever add-ons are on. If a
package or generator name changed upstream, verify against current docs
before running — don't swap in a different library.

### Layout

```
docker-compose.yml   local Postgres (+ Redis if Queue add-on is on) — every host OS, no native install
apps/
  web        Next.js — UI only
  mobile     Expo — only if Mobile add-on is on
  api        NestJS — owns all domain logic + DB access
  worker     BullMQ consumers — only if Queue add-on is on
packages/
  db         Drizzle schema + client
  contracts  ts-rest + Zod contracts
  hooks      TanStack Query — shared web + mobile
  jobs       typed job registry / queue definitions — only if Queue add-on is on
  auth       Better Auth config — only if Auth add-on is on
  config     locked ESLint/Prettier/tsconfig/env schema
  shared     cross-cutting types + utils
libs/
  <module>/port · <module>/repository · <module>/service   (one triplet per table)
.hedgehog/
  hedgehog.db    the build graph — intents, tasks, dependencies, verifications, committed to git
  addons.yaml    the Add-ons decision (Auth/Queue/Mobile), from planner
  BMAD/          archival planning intake output (brief, PRD, UX spec, research) — write-once, from planner
docs/
  design     <module>.md (ux-planner, reading .hedgehog/BMAD/05-ux-spec/ directly)
```

Check `.hedgehog/addons.yaml` before assuming any "only if" line above is
actually present in this codebase.

### Core rules

- **One table = one domain module.** Each carries the full step sequence.
- **Cross-module references are FK-by-ID only.** A service imports only
  its own ports — never another module's adapter. (Enforced by Nx module
  boundaries; building out of order fails `nx lint`.)
- **Backend before frontend.** Phase A (schema → contract → repository →
  service → controller → queue?) closes for a module before Phase B
  (hooks → screen) opens. Enforced by the CI phase gate.
- **Sequential within a phase.** A step starts only once the previous one
  compiles and passes tests.
- **One step = one commit**, in the exact Conventional Commit format from
  `hedgehog-loop`. A commit that fails typecheck/lint/test does not happen
  (lefthook gate).
- **Fix wrong steps at the source** via the Correction Protocol — never a
  downstream workaround.
- **Local Postgres always runs through `docker-compose.yml`**, on every
  host OS, regardless of add-ons; Redis joins it only if the Queue add-on
  is on. Never a natively-installed Postgres or Redis, even to match a
  contributor's existing local setup.
- **`packages/config` is the single source** for shared config. A per-app
  override request means fix the base config, not add an override.
