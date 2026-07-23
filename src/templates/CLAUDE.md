<!--
  Hedgehog project CLAUDE.md template.

  This file is copied into a consuming project's repo root at install
  time. Placeholders wrapped in {{ }} are filled in once, at planning
  intake, by the `planner` agent (or by hand). Everything outside the
  placeholders is a constant of the Hedgehog discipline and should be
  left as-is.

  Delete this comment block after the placeholders are filled in.
-->

# {{PROJECT_NAME}}

{{PROJECT_SUMMARY — 2–4 sentences the `planner` writes at planning
intake: what this project is, who it's for, and what it does. State
current intent, not history. Keep it tight — the full product narrative,
scope boundary, and domain vocabulary live in `.hedgehog/BMAD/` (the
planning documents) and `TODO.md`, not here.}}

This project is built with **Hedgehog**: a backend-first, one-step-at-a-time
build discipline. The rules below aren't project preferences — they're how
the build stays mechanically correct. Follow them exactly.

## First message in a fresh install

If `{{PROJECT_SUMMARY}}` above is still an unfilled placeholder, this is a
brand-new install and nothing has been built yet. Open with something
short and warm — 🦔 plus one line asking what the user wants to build —
then hand straight to `planner`, which runs planning intake on
BMAD-METHOD (brainstorming → brief → PRD → UX spec), then mines that
output into Hedgehog's own scope boundary and `## Add-ons` decision.
Don't re-explain the discipline or summarize this file; the greeting is
one line, not a tour. Skip this entirely once the placeholder is filled
in — every later session starts with `TODO.md`, not a greeting.

## How to work here

The build is a loop of small, gated, committed steps. You never hold the
whole plan in context — the plan lives in the structure:

- **`TODO.md`** is the live checklist and the source of truth for what's
  next, including the `## Add-ons` block (Auth/Queue/Mobile, each on or
  off). Read it at the start of every session. Its only state is
  checked/unchecked.
- **`.hedgehog/BMAD/`** is the archival record of planning intake —
  BMAD-METHOD's brainstorming, brief, PRD, and UX spec output, written
  once by `planner` and never edited after. It's historical record, the
  same relationship the commit log has to a merged PR — nothing in the
  day-to-day build reads it live.
- **The commit log** is the record of what's built and why. Conventional
  commits (`feat(<module>): schema`, `feat(<module>): api`, …) are how
  progress is read, not a conversation summary.
- **The architecture is fixed and opinionated** — the same on every
  Hedgehog project. Where a service lives, what it may import, the module
  shape, the phase order: all of it is inferable from this file and the
  skills *without reading a line of code*. You don't discover the
  patterns; you already know them.
- **The codebase carries the project-specific instances** — which modules
  exist, what a given schema's columns are, what's already wired. That,
  you re-read from the code when you need it, rather than remembering it.

Because state lives in those places and not in the conversation, a fresh
context loses nothing: the architecture is known a priori, and the
project's specifics are re-read on demand. Use that (see **Managing
context** below).

### The skills — invoke these, don't improvise

The discipline is packaged as skills. Use them; don't reconstruct their
steps from memory:

- **`hedgehog-loop`** — every unit of work once bootstrapped: pick the
  next step from `TODO.md`, build exactly one, gate it, commit it, check
  it off. Also holds the Correction Protocol for fixing a wrong upstream
  step. Invoke it at the start of any build session and for "what's next".
- **`hedgehog-bootstrap`** — run **once**, at project start, to scaffold
  the core stack, the enforcement config, and whichever add-ons (Auth,
  Queue, Mobile) planning intake turned on. Skip if `nx.json` already
  exists.
- **`conventional-commits`** — when a change spans several steps in one
  working-tree pass and needs splitting back into per-step commits (mainly
  Correction Protocol cleanups).

### The agents — delegate the judgment calls

- **`planner`** — planning intake (whether Hedgehog applies at all, then
  `hedgehog-planning-intake`'s BMAD-METHOD brainstorming/brief/PRD/UX-spec
  shelf, mined into scope boundary, the Add-ons decision, and domain
  vocabulary) at project start, and module scoping when new scope enters
  play. Writes `TODO.md` (including its `## Add-ons` block),
  `.hedgehog/BMAD/`, and `docs/design/<module>-notes.md`. On first run,
  hands off to the `bootstrap` agent once Confirm & Lock holds.
- **`bootstrap`** — runs `hedgehog-bootstrap`'s core steps (always) plus
  whichever add-on steps planning intake turned on. Triggered
  automatically by `planner` after its first run; skip if `nx.json`
  already exists.
- **`ux-planner`** — once per module in Phase B, after the hook exists and
  before the screen: writes `docs/design/<module>.md`.
- **`ui-builder`** — builds screens from the ux-planner rationale.
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
recorded in `TODO.md`'s `## Add-ons` block; check that block for this
project's actual picks rather than assuming any of these are present:

| Add-on | Adds |
| --- | --- |
| Auth | Better Auth, `packages/auth`, a global auth guard on `apps/api` |
| Queue | BullMQ + Redis, `apps/worker`, a `Queue` port/adapter seam |
| Mobile | Expo + React Native Reusables + NativeWind, `apps/mobile` |

An add-on that's off means the corresponding piece of infra genuinely
isn't in this codebase — don't write code assuming `packages/auth`,
`apps/worker`, or `apps/mobile` exist without checking `TODO.md`'s
`## Add-ons` block first.

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
  BMAD/      archival planning intake output (brief, PRD, UX spec, research) — write-once, from planner
docs/
  design     <module>-notes.md (planner, sourced from BMAD's UX spec) and <module>.md (ux-planner)
```

Check `TODO.md`'s `## Add-ons` block before assuming any "only if" line
above is actually present in this codebase.

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

## Consuming TODO.md

`TODO.md` at repo root is a thin checklist mirroring the phase/step
structure. To work from it:

1. Read it. Find the first unchecked step whose gate (the step before it)
   is satisfied.
2. Confirm the phase: a module with a `feat(<module>): api` commit is in
   Phase B; otherwise Phase A.
3. Build that one step via `hedgehog-loop`.
4. Check the line off after the commit lands. Checked/unchecked is the
   only state — no notes, no rationale (that's the commit log's job).

`planner` owns writing and extending `TODO.md`; the loop only checks boxes
off. Keep it thin.

**When the build is done:** once every module in scope has both phases
checked, the build session is complete. **Delete `TODO.md`** — a finished
checklist is noise, and the commit log is the durable record of what was
built. **`.hedgehog/BMAD/` stays** — it's the archival planning record,
not a checklist.

## Managing context

Hedgehog is designed so the conversation is disposable. Keep the working
context small:

- **Clear context at module boundaries.** After a module's Phase A (or a
  whole module) is done and committed, `/clear` and start fresh — re-read
  `TODO.md` and continue. Nothing is lost, because the checklist, commits,
  and code hold all the state. Prefer this over letting one session
  accumulate the entire project.
- **A cleared or new session recovers by reading `TODO.md` and the
  commit log**, never by needing the prior conversation. `.hedgehog/BMAD/`
  is available if the product narrative itself needs re-reading, but
  day-to-day recovery doesn't need it.
- **Delegate heavy work to agents.** The project scaffold (`bootstrap`),
  planning intake (`planner`), screen builds (`ui-builder`), and
  reviews (`reviewer`) each run in their own isolated context — so that
  work doesn't pile up in the main thread.
- **Don't paste large context back in.** If you find yourself
  re-explaining the architecture, stop — it's fixed and stated in this
  file, not something to reconstruct. If you need a project specific, read
  it from the code. That's the self-documenting design working as
  intended.
