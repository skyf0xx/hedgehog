---
name: hedgehog-adopt
description: Use once, at the start of bringing Hedgehog's discipline to an existing repo whose code Hedgehog didn't build — "adopt this repo", "add Hedgehog here", "I want scope/verify enforcement on my changes to this existing codebase". Invoked by the `planner` agent as Phase 0's fourth outcome, in place of any bootstrap skill. Reads the repo read-only, proposes a linear-chain `.hedgehog/core.yaml` whose `verify` commands are the repo's own, and writes only `.hedgehog/` — never touches working code. Also invoked again, briefly, whenever new change-work enters play on an already-adopted repo.
---

# Hedgehog Adopt

Brings Hedgehog's discipline to a repo that already exists, without
bootstrapping a workspace. On every other core, bootstrap generates or
copies a workspace before any build step runs. Here there is nothing to
generate — the workspace already exists, built by whoever wrote this
repo — so this skill replaces bootstrap entirely rather than extending
it. It writes `.hedgehog/` and nothing else, ever.

## What this is, precisely

Hedgehog on an existing repo is a **permanent discipline for how change
lands**, not a model of what exists. The build graph covers new work
only. Pre-existing code is context to read and respect, never a node in
the graph — no task is ever created to "build" something that's already
there.

This is what makes adoption safe to run on a real, live codebase:

- **No repo mapping.** This skill never tries to enumerate or represent
  the existing architecture as build-graph state.
- **No completion backfill.** It never fabricates commits to make
  `hedgehog db rebuild` believe pre-existing files were built by
  Hedgehog. `rebuild.mjs` marks a task complete only when a real commit's
  subject matches its `commit_message` — inventing that history would be
  fiction in the permanent record, so this skill doesn't.
- **No stack migration.** The repo's language, tooling, and conventions
  are already decided. This skill never proposes moving them toward any
  Golden Core's stack — not Nx, not Drizzle, not anything else Hedgehog
  is opinionated about elsewhere. Every `verify` command it writes is one
  of the repo's own commands, confirmed with the user, never invented.
- **No legacy-code review.** `reviewer`, once this core is running,
  judges only the unit under change — never findings against pre-existing
  code nothing asked it to look at.
- **No generators.** Nothing here scaffolds files the way a Golden
  Core's bootstrap does. This skill's only output is `.hedgehog/`.

What *does* transfer from the rest of Hedgehog, unweakened: scope as a
hard boundary on every task, no self-certification (only `hedgehog
verify`'s exit code moves state and commits), the dependency graph and
its leases and safe parallelism, small per-layer context loops, and
`reviewer`/`debt`/`friction` as real channels. On an existing codebase
scope enforcement is worth *more* than on a fresh one: blast radius is
the primary risk on code you didn't write, and bounding it is the one
thing a generic agent setup doesn't give you.

## When this runs

`planner`'s Phase 0 routes here as a fourth outcome, distinct from "which
shipped core fits" or "author one" — the question here isn't which core
fits new work, it's that no new workspace is being built at all. Skip
`hedgehog-planning-intake`'s BMAD shelf entirely: BMAD elicits product
drivers (persistence, deployment target, integration surface) that are
already settled facts of a repo that already exists, not open decisions
to interview for.

Two entry shapes:

- **First run** — nothing under `.hedgehog/` yet. Run every step below
  through Confirm & Lock, then add the first intent(s).
- **Later run** — `.hedgehog/core.yaml` already exists and was written by
  this skill (its own record — see Step 5). New change-work entered play.
  Skip straight to "Adding change-work" below; every earlier step is
  already-locked, write-once state.

## Step 1 — read the repo, read-only

Before proposing anything, read enough of the repo to answer:

- **Layout.** Where source lives, where tests live, whether there's a
  monorepo structure (workspaces, packages) or a single package.
- **Package manager and toolchain.** `package.json`/`pnpm-lock.yaml`/
  `yarn.lock` (which one), `Cargo.toml`, `pyproject.toml`, `go.mod`,
  whatever the repo's own manifest is.
- **Existing commands.** `package.json` `scripts` (test, lint, typecheck,
  build), a `Makefile`, CI config (`.github/workflows/*.yml`,
  `.gitlab-ci.yml`) — CI config is often the most trustworthy source,
  since it's what the repo's own maintainers already run as their bar for
  "this change is good."
- **Natural seams.** Places where a change plausibly needs to move in a
  fixed order — a schema or migration before the code that reads it, a
  shared type or contract before its consumers, a public API before an
  internal one. Not every repo has these; a repo with no natural
  ordering constraint gets a single-layer chain (see Step 3).

This step is entirely read-only. Never write, edit, or run anything that
mutates the working tree here — no `npm install`, no formatter, nothing.

## Step 2 — propose the verify commands, confirm with the user

Candidate commands come only from what Step 1 actually found — never
invented, never assumed from convention ("this looks like it should have
a lint script"). Show the candidates and their source (`package.json`
script name, Makefile target, CI job step) and get explicit confirmation
before writing anything.

This is the highest-leverage step in the whole skill and the one place a
mistake is silent rather than loud: a `verify` command that doesn't
actually check what it claims to (a script that's a no-op, a lint config
so lenient it never fails, a test command that runs zero tests) still
exits 0, so `hedgehog verify` commits work that was never actually
checked. It looks like success. Read what a candidate command actually
does — not just its name — before proposing it: a `"test": "echo
ok"` placeholder script is a real thing real repos have.

If the repo has no test command at all, say so plainly rather than
inventing one. A layer's `verify` can be a typecheck or lint alone if
that's genuinely all the repo has — an honest, weaker gate beats a
fabricated test command that doesn't exist.

## Step 3 — propose the layer chain

**Linear chain, no `{module}` anywhere.** Change order is not
construction order — there's no "schema before service" here, because
nothing is being constructed. The chain expresses, for a given batch of
change-work, which seam moves first and what has to be re-verified after.
A repo with no natural seam (Step 1 found none) gets the degenerate case:
one layer, scope `["**"]`, verify the repo's full check. A repo with a
real seam (e.g. a shared package other packages depend on) gets that
seam as an earlier layer, `depends_on` chaining the rest after it — the
same pattern `landing-page`'s brief → feeling → tokens → sequence →
artifact chain already establishes for a linear, no-module-axis core
(`src/golden-cores/landing-page/core.yaml`).

Linear chain is not a simplification made for this skill's convenience —
it's what sidesteps `core.mjs`'s module-axis uniformity rule
(`validateCore`, `src/db/core.mjs:603`): a core where any layer's scope
carries `{module}` requires every non-`exclusive`/non-`once` layer to
carry one too, which fights any repo not laid out module-per-directory.
Never introduce `{module}` here.

**Always end with a `join`-style tail layer**: `scope: ["**"]`,
`exclusive: true`, verify the repo's full check (typecheck + test,
whatever Step 2 confirmed covers the whole repo) — the cross-cutting
safety net, the same pattern `full-stack-app`'s own `join` layer
establishes. This is what catches a change that passed its own narrow
layer's verify but broke something the narrower verify command couldn't
see.

Each layer's `commit` uses the repo's own conventional-commit style if it
has one (read a handful of recent commit subjects to tell), or standard
Conventional Commits otherwise.

## Step 4 — write `.hedgehog/adoption.md`

The rationale, write-once, archival — same stance as `core-design.md` on
an authored core: what the repo's own commands are and their source,
why the layers are ordered the way they are (or why there's only one,
for a repo with no natural seam), and what was deliberately left out
(repo mapping, stack migration, legacy review — name these explicitly so
a later reader doesn't wonder whether they were forgotten). No nested
YAML-shaped content — this file is prose, `core.yaml` is the only file
the engine parses.

## Step 5 — Confirm & Lock

🔒 Show, in full:

- The commands Step 2 confirmed and where each came from.
- The layer chain in order: what each owns, its scope globs, its verify
  command, its commit message.
- The tail `join` layer explicitly, and what it catches that the earlier
  layers don't.
- Plainly, in these words or equivalent: *"This adds Hedgehog's
  discipline to how change lands on this repo from here forward. It
  never touches your existing code, never converts your stack, and never
  tries to model what's already here — only new work goes through this
  graph. Coverage will always be partial by design."*

Wait for explicit go-ahead. On confirmation, write `.hedgehog/core.yaml`
(exact format `src/db/core.mjs` parses — see any shipped core.yaml for
the shape) and `.hedgehog/adoption.md`. Verify the file loads before
showing it back:

```bash
node -e "import('<path-to-hedgehog-install>/src/db/core.mjs').then(m => m.loadCore('.hedgehog/core.yaml')).then(c => console.log(JSON.stringify(c, null, 2)))"
```

Nothing else gets written at adoption time. No working code, no
`package.json` edits, no formatter run, no root `CLAUDE.md` project
placeholders — `{{PROJECT_NAME}}`/`{{PROJECT_SUMMARY}}` describe a
project Hedgehog is building, and adoption isn't building one, so leave
them alone. Fill root `CLAUDE.md`'s `{{CORE_SECTION}}` placeholder with
`src/templates/CLAUDE.core.adopted.md`'s content — the same mechanic
`hedgehog-bootstrap-authored-core` uses for an authored core, done here
directly since there is no bootstrap step on this path to do it.

## Adding the first (or next) change-work

Once `core.yaml` is locked, add intents the same way any other core does
— `hedgehog intent add --id <id> --goal <goal> --outcome <outcome>`, one
per distinct unit of change, each `id` naming the change rather than a
domain module (`fix-auth-timeout`, `add-rate-limiting`, not a table or
screen name — there's no module axis here). Then `hedgehog plan` compiles
it through the locked chain. This is the same shape whether it's the
first intent on a freshly adopted repo or the fifth one three months
later — adoption has no first-run-only intent step the way planning
intake does; every entry is the same mechanical add.

Commit this as `chore(planning): adopt` (first run, alongside the
Confirm & Lock commit) or `chore(planning): adopt change` (every later
run adding new change-work) — distinguishable from `hedgehog-planning-
intake`'s own `chore(planning): intake`/`extend scope` messages, since no
BMAD archive backs either of these.

From here, hand off to `hedgehog-authored-loop` — this core's
`core.yaml` is shaped exactly like an authored core's, so the same loop
skill runs it unmodified: `hedgehog claim` reserves the packet, `layer-
eng` builds it, `hedgehog verify` gates and commits it. That skill's
"Module axis" section always reads as linear chain here; its Correction
Protocol and Stop Condition apply as written, with one addition — see
"No global Stop Condition" below.

## `hedgehog why` on pre-existing code

A file this skill's chain never touched has no `artifacts` row, because
Hedgehog never built it — `hedgehog why <path>` already says so plainly
(`(no artifact recorded for this path)`) rather than erroring or
returning something misleading. That's the correct, expected answer for
almost every file in a freshly adopted repo. It is not a bug to route
around and not something this skill tries to backfill.

## No global Stop Condition

Every other core's Stop Condition fires once the whole graph is
`complete` — the project is done. Adoption has no such moment: it is the
permanent way change lands on this repo from here on, not a build that
finishes. Read `hedgehog-authored-loop`'s Stop Condition as **per-change,
never whole-graph**: `hedgehog boundary` still answers "is now a safe
moment to clear context" for the change currently in flight, and that
check is exactly as useful here as anywhere else. What doesn't apply is
treating "every task complete" as a project-level milestone worth a
handoff ceremony — there's always a next change, and the next one is
just another `hedgehog-adopt` intent add away.

## Coverage is partial — say so

`hedgehog status` and `hedgehog boundary` describe the state of work
under discipline, never the state of the repo as a whole. On an adopted
repo this matters more than it does elsewhere: a fresh Hedgehog project's
graph and its repo are the same size by construction, but an adopted
repo's graph only ever covers what's passed through it since adoption.
Never let a status summary imply broader authority than that — if asked
"is this repo fully covered," the honest answer is always "no, only the
changes that went through Hedgehog since adoption are," not a count that
could be misread as a percentage of the whole.

## Constraints

- **Never touch working code, at adoption time or ever, as this skill.**
  The only writes this skill makes are `.hedgehog/core.yaml`,
  `.hedgehog/adoption.md`, root `CLAUDE.md`'s `{{CORE_SECTION}}`
  placeholder (first run only), and the build graph via `hedgehog intent
  add`/`hedgehog plan`. Everything else — the actual change-work — is
  `layer-eng`'s job through `hedgehog-authored-loop`, gated the same as
  any other layer.
- **Never propose converting the repo's stack, structure, or conventions
  toward any Golden Core's** — not Nx, not a particular ORM, not a
  particular framework. Not even phrased as a suggestion. This is the one
  headline pillar (opinionated stack + generators) that deliberately does
  not come along to a brownfield adoption — say so if asked, don't quietly
  work around it.
- **Never invent a `verify` command.** Every one comes from something
  Step 1 actually found in the repo and Step 2 actually confirmed with
  the user. A wrong `verify` command is the worst failure mode available
  — it looks like success while checking nothing.
- **Never create a task for pre-existing code.** The graph is
  change-scoped by construction; a task exists only for work an intent
  actually asked for.
- **No `{module}` anywhere in `core.yaml`.** Linear chain only — see Step
  3 for why.
- **Always end the chain with an `exclusive: true`, `scope: ["**"]` join
  layer.** This is the cross-cutting net that catches what a narrower
  layer's verify can't see.
- **`.hedgehog/core.yaml` and `.hedgehog/adoption.md` are locked once
  written**, the same as an authored core's two files. A layer chain that
  turns out wrong is a re-run of this skill to add or adjust a layer via
  a fresh Confirm & Lock, not a silent edit — and never touches tasks
  already compiled or completed (see `hedgehog-authored-loop`'s
  "core.yaml vs. the packet" for the drift/reconcile mechanics, which
  apply here unchanged).
