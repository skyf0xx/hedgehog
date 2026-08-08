---
name: hedgehog-core-design
description: Use on full-stack-app and landing-page alike only when neither shipped Golden Core fits a project that is still building something real — picks the stack and designs the layer sequence for it, and writes `.hedgehog/core.yaml`. Invoked by the `planner` agent as Phase 0's third outcome, after the vendored BMAD shelf has run; don't run standalone and don't run when a shipped core fits.
---

# Hedgehog Core Design

Designs a core definition for a project no shipped Golden Core fits.
Hedgehog decides the architecture here — the stack, the layers, their
order, their file scope, their verification — and shows it back for
confirmation. The user is asked about their product, never asked to pick
a stack or design layers; a person who could name the right stack and
layer sequence unprompted wouldn't need a build discipline to enforce it.

The output is one file, `.hedgehog/core.yaml`, in the exact format
shipped cores use (spec: "Core definitions"). Everything else this skill
produces is rationale, and rationale goes to `.hedgehog/core-design.md`,
not into `core.yaml` — the loader (`src/db/core.mjs`) parses a narrow
YAML subset and throws on anything outside it.

## When this runs

After `hedgehog-planning-intake`'s Phase 0, not before. An architecture
can't be designed from a one-line project description: the drivers that
decide it — persistence, concurrency, deployment target, integration
surface — are exactly what BMAD's brief and PRD elicit. So `planner`'s
Phase 0 reaches its third outcome ("neither shipped core fits, but
something is being built"), runs the BMAD shelf in full, then opens this
skill against that archive. Intent mining follows this skill, not the
other way round — the layer sequence has to exist before `hedgehog plan`
can compile anything against it.

## Step 1 — name the system shape

Say what the project fundamentally is, in one line, before deriving
anything from it: a CLI, a library or SDK, a data pipeline, a browser
extension, a desktop app, a compiler or language tool, a bot or agent, a
game, an infrastructure/deploy tool. Pick the dominant one. A project
with several surfaces has one primary system and the rest are layers
inside it, not co-equal architectures.

This is the step that catches a misrouted Phase 0. If the shape you land
on is "a web app with a database behind it," that is `full-stack-app` and
you should say so and route back rather than author a near-copy of a
shipped core under a new name. The same goes for a marketing page that
grew a second page — still `landing-page`.

## Step 2 — pick the stack

Name the language, package manager, and the one or two frameworks that
shape the architecture (a web/CLI/RPC framework, not every library the
project will eventually need) before deriving layers — a layer's `verify`
command can't be written until the test runner and build tooling are
decided, and layer boundaries themselves often follow framework
conventions (e.g. a middleware layer only exists if the framework has
middleware). Don't ask the user to choose — see the opening section
above; the same reasoning applies here.

Pick one default per system shape, the same way the shipped cores commit
to one choice per row rather than a menu (`hedgehog-bootstrap`'s stack
table). Substitute off a default only for a concrete, named constraint
read from `.hedgehog/BMAD/` — never a general preference for variety.
Prefer an opinionated framework over a bare library wherever the shape
has one (a web/CLI/RPC framework that fixes where things live, the way
NestJS does for `full-stack-app`) — an opinionated default is a guardrail
this discipline doesn't have to write down, and is worth more than the
popular thin alternative:

| System shape | Default stack | Substitute when |
|---|---|---|
| CLI | TypeScript + Node, Commander, Vitest, pnpm | the target users are a Python-first or Go-first ecosystem (data/ML tooling → Python + Typer + pytest; infra/systems tooling → Go + Cobra + `go test`) |
| Library / SDK | TypeScript, tsup, Vitest, pnpm | the consuming ecosystem is fixed by the brief (a Python package → Python + Hatch + pytest; publishing to both → author the TS core first, wrap it) |
| Data pipeline | Python, stdlib/argparse or Dagster for orchestration, pytest, uv or pip | the pipeline is thin glue over an existing Node/TS service mesh already named in the brief |
| Browser extension | TypeScript + WXT (bundles the content-script/background/popup entry points and the WebExtension API types), Vitest, pnpm | none in practice — this shape has one real ecosystem |
| Desktop app | TypeScript + Electron, Vitest + Playwright, pnpm | native platform integration is a stated hard requirement (macOS/Windows-only, deep OS API use) → Swift/AppKit or C#/WinUI, per platform, named explicitly |
| Compiler / language tool | Rust, `cargo test`, Cargo | the brief is explicitly about fast iteration over raw performance, or targets a JS/TS-only toolchain (a Babel/ESLint plugin) → TypeScript, Vitest, pnpm |
| Bot / agent | TypeScript, Vitest, pnpm | the brief calls for heavy ML/data-science library use → Python, pytest, uv |
| Game | TypeScript + PixiJS (2D) or Three.js (3D), Vitest, pnpm — read the dimensionality off the brief; an engine the brief names outright wins over both | a native/console target is explicit → the engine the brief names, per that engine's own language (see the caveat below) |
| Infra / deploy tool | Go, `go test`, Go modules | the tool is a thin wrapper generating config/manifests with no systems-level need → TypeScript, Vitest, pnpm |

A shape not on this table is rare enough that no default has been
battle-tested — reason from the same drivers `hedgehog-bootstrap`'s
table encodes (ecosystem the target users already live in, deployment
target, the language the brief's own examples or comparables are
written in) and name the result as a judgment call, not a table lookup,
in `core-design.md`'s rationale.

Where a substitution lands on a stack whose primary artifacts are binary
(engine scenes and prefabs, visual-editor projects, compiled design
files), say so at Confirm & Lock. Scope globs and `verify` commands still
hold on that stack's text sources, but a layer whose real output is a
binary file can't be diffed or meaningfully gated, so the enforcement is
partial in a way the text-source defaults aren't. That's a reason to
prefer a text-source stack where the brief leaves it open, and a fact the
user should have before confirming where it doesn't.

Record the choice as one line — language, package manager, the named
framework(s), test runner — before moving to Step 3. Alongside it, record
a one-line decision for each of these concerns, whichever apply to the
shape (a browser extension has no DI story; a data pipeline has no
routing layer) — each is a place an authored core silently forks into
per-project convention if left unstated, the way `full-stack-app` never
has to think about because NestJS already decided:

- **Composition** — how one part of the system gets a dependency it
  doesn't construct itself (a DI container, explicit constructor passing,
  a module registry).
- **Error model** — how a failure crosses a layer boundary (typed
  exceptions, a `Result`/`Either` return, error codes).
- **Config and secrets** — where runtime configuration is read from and
  validated (env vars through a typed schema, a config file, flags).
- **Entrypoint layout** — what file the runtime starts from and how it
  wires the layers together.

Every layer's `scope` and `verify` in Step 3 draws from this record.

## Step 3 — derive the layers

Read `.hedgehog/BMAD/` for what the system actually does, then decide the
layers it builds in. A layer earns its place by owning a distinct
artifact that can be verified on its own. Order by dependency first (a
layer that another layer imports comes first), by contract second (a
layer that pins an external interface — a schema, a wire format, a public
API surface — comes before the layers that build against it, the way
`full-stack-app` puts `schema` before `contract` before everything else),
and by risk third (where two layers are still tied, build the one that
would invalidate the other if it went wrong first).

Start from the blueprint for the chosen system shape — a starting
sequence, not a fixed one. Each blueprint names where it's safe to add,
merge, or drop a layer for the project at hand, and the one boundary that
has to hold whatever else changes; treat those adaptation points as
expected, not as exceptions. Record which blueprint was used and what
changed from it in `core-design.md`'s rationale (Step 6).

| System shape | Blueprint |
|---|---|
| CLI | [blueprints/cli.md](blueprints/cli.md) |
| Library / SDK | [blueprints/library-sdk.md](blueprints/library-sdk.md) |
| Data pipeline | [blueprints/data-pipeline.md](blueprints/data-pipeline.md) |
| Browser extension | [blueprints/browser-extension.md](blueprints/browser-extension.md) |
| Desktop app | [blueprints/desktop-app.md](blueprints/desktop-app.md) |
| Compiler / language tool | [blueprints/compiler-language-tool.md](blueprints/compiler-language-tool.md) |
| Bot / agent | [blueprints/bot-agent.md](blueprints/bot-agent.md) |
| Game | [blueprints/game.md](blueprints/game.md) |
| Infra / deploy tool | [blueprints/infra-deploy-tool.md](blueprints/infra-deploy-tool.md) |

A shape off this table gets no starting sequence — derive layers directly
from this step's rules and the BMAD brief, and name that in
`core-design.md` as a judgment call, the same as an off-table stack.

Three rules with teeth, on every blueprint and every derived sequence
alike:

- **A layer with no executable verification is not a layer.** Fold it
  into its neighbour or drop it. `verify: manually inspect` is not a
  verify command, and the loader rejects an empty one outright
  (`validateCore`, `src/db/core.mjs`).
- **A layer whose file scope overlaps another layer's must be rejected,
  full stop.** Scope is what stops step N from quietly rewriting step
  N−1's work, and it's also what the scheduler reads to decide two tasks
  can run concurrently (`conflict.mjs`) — overlapping globs break both at
  once. The loader does not check this for you: `validateCore`
  (`src/db/core.mjs`) only rejects a missing scope and, on a module-axis
  core, a layer whose scope omits `{module}`; it does not scan every pair
  of layers for a general scope collision. Getting this right is on
  whoever designs the core — check every layer's scope glob against every
  other layer's by hand before Step 5, not just against its immediate
  neighbour.
- **Don't reproduce a Golden Core's sequence under new names.** If
  schema → contract → repository → service → controller is genuinely
  right, Phase 0 picked the wrong outcome.

Four to seven layers is the usual range. Fewer than three means the
project probably wanted a shipped core or no core at all; more than eight
means several layers are one layer with internal steps. This list isn't
final until Step 4 — a module axis can still add a cross-cutting layer to
it.

## Step 4 — decide the module axis

Answer explicitly, because it changes the shape of the whole graph:

- **Module axis** (like `full-stack-app`) — the layer chain instantiates
  once per intent. Every scope glob, verify command, and commit message
  that differs per module carries the `{module}` placeholder, which
  `hedgehog plan` fills with the intent's id (`src/db/plan.mjs`). The
  graph is intents × layers tasks.
- **Linear chain** (like `landing-page`) — one pass total, no `{module}`
  anywhere. The graph is one task per layer. Mine the project as a single
  intent.

Choose a module axis when the project has repeating units of domain work
that each walk the same layers (entities, commands, resources,
integrations). Choose a linear chain when the project is built once,
front to back.

Getting this wrong is the most common failure. A module-axis core whose
scopes omit `{module}` gives every intent identical scope globs, so
intent A's task may write intent B's files and the scope enforcement that
justifies authoring a core at all disappears. Check every glob before
writing the file.

On a module axis, also **ask explicitly whether the stack implies
cross-cutting infrastructure no single module should own** — a shared
background script coordinating state across every module's tabs (a
browser extension), a shared event bus, global app state. Every layer in
Step 3 instantiates once per intent; this is the thing that doesn't fit
that shape, and left undesigned it either gets deferred with no owner or
bolted onto whichever module's layer needs it first, quietly widening
that layer's scope past what it was designed to own.

If yes, add it to Step 3's layer sequence as its own layer, before the
file is written — a layer whose `scope` is a fixed path with no
`{module}` placeholder, marked **`once: true`**. Name it for what it owns
(e.g. `background-infra`), give it its own `verify` command, and record
in `core-design.md` why no single module was made to own it.

`once: true` is the cardinality declaration, and on a module axis it is
not optional for such a layer. Without it the layer still instantiates
per intent: six modules compile six identical `terraform apply` tasks,
five of them replaying work the first one already did, and the commit log
attributes shared infrastructure to whichever module happened to compile
first. With it the layer compiles exactly one task, id `<LAYER>` with no
module prefix, owned by the core rather than by any intent — and the
dependency edges resolve across the boundary in both directions: a
per-module layer that `depends_on` it waits on the single task, and a
`once` layer that `depends_on` a per-module layer waits on *every*
module's copy. That makes a head `once` layer a gate on the whole build
and a tail one a join after every module has landed.

Two rules follow from compiling one task. A `once` layer must carry no
`{module}` anywhere — scope, verify, commit, or verify_radius — since
there is no module to substitute; `validateCore` rejects it outright. And
a core cannot be all `once` layers: at least one layer has to be
per-intent, or no intent compiles anything.

A `once` layer that sits *below* per-module layers is re-entrant by
design, and that shapes what belongs in one. When `planner`'s Re-entry
pass adds a new module to a finished build, the new module's task becomes
a prerequisite of that already-complete layer, so `hedgehog plan` reopens
it and says so — otherwise the graph would report the build done with the
new module never deployed. Design such a layer to be safe to run more
than once: `terraform apply` and `kubectl apply` are, a migration that
assumes a fresh database is not.

`once` and `exclusive` are different axes and often both apply.
`once: true` is *how many tasks compile*; `exclusive: true` is *whether
the one that compiled may run alongside anything else*. Shared
infrastructure that mutates live state (`terraform apply`, `kubectl
apply`) usually wants both.

## Step 4b — declare each layer's verify radius

For each layer, ask: does this layer's `verify` command only read files
inside its own `scope`, or does it also read, or typecheck, a wider
package or project? A test runner scoped by filename or filter token
usually stays inside `scope`. A typecheck or build step often doesn't —
`tsc` has no per-module isolation, so a command like `pnpm nx test db
--testPathPattern={module}` typechecks the whole `packages/db` project on
every run, regardless of which module's tests it filters to.

Where the verify command reads wider than `scope`, declare that wider set
as `verify_radius` explicitly. Where it truly only touches its own scope,
leave `verify_radius` undeclared — it defaults to `scope` when unset
(`conflict.mjs`'s `verifyRadius()`), which is the optimistic default:
absent a declaration, the scheduler assumes a layer's verify command
reads nothing outside what it writes.

Get this wrong in either direction and the failure isn't symmetric. An
over-wide radius is a performance bug: it needlessly serializes two tasks
that could safely run together, since the scheduler treats any overlap in
declared radius as a conflict — nothing breaks, work just runs slower
than it has to. A too-narrow radius is a correctness bug: it tells the
scheduler two tasks are safe to co-run when the verify command actually
reads files outside its declared scope, which can produce a false pass or
a flaky verify when a neighboring in-flight task's files get picked up
mid-run.

Worked example: a Drizzle schema layer scoped to
`packages/db/src/schema/{module}/**` with `verify: "pnpm nx test db
--testPathPattern={module}"` looks module-scoped by its test filter, but
the command typechecks all of `packages/db`, not just that module's
files. Its true verify radius is the whole package —
`verify_radius: ["packages/db/**"]` — not just its own scope glob, so two
modules' schema tasks correctly serialize against each other on that
radius even though their scopes don't overlap.

## Step 5 — write `.hedgehog/core.yaml`

The loader parses `id` plus a `layers` list of flat maps. Every layer
needs all five fields — `depends_on` is omitted only on the first layer:

```yaml
id: cli-tool
layers:
  - id: command-model
    scope: ["src/commands/**"]
    verify: "pnpm test commands && pnpm typecheck"
    commit: "feat({module}): command model"
  - id: domain
    depends_on: command-model
    scope: ["src/domain/{module}/**"]
    verify: "pnpm test {module}-domain"
    commit: "feat({module}): domain"
  - id: adapter
    depends_on: domain
    scope: ["src/adapters/{module}/**"]
    verify: "pnpm test {module}-adapter"
    commit: "feat({module}): adapter"
```

Constraints the loader and compiler impose, all of them silent failures
if missed:

- **`commit` is required in practice**, though `validateCore` doesn't
  check it. `hedgehog plan` writes `commit_message` from it for every
  task (`src/db/plan.mjs`); a layer without one compiles to a task with
  an empty commit message, and the Correction Protocol and `hedgehog why`
  both hang off commit shape. Use the conventional-commit form every
  other core uses: `feat({module}): <layer>`, or `feat(<project>):
  <layer>` on a linear chain.
- **`scope` must be an inline list** — `["a/**", "b/**"]` on one line.
  Block sequences under `scope:` don't parse.
- **No nesting beyond a layer's flat fields.** Flat top-level keys other
  than `id` and `layers` are ignored, but any nested block
  (`architecture:`, `modules:`, `decisions:`) throws at load. Rationale
  belongs in `.hedgehog/core-design.md`.
- **`depends_on` names one layer** that exists in this same core, and the
  chain must be acyclic. The compiler walks it directly into
  `dependencies` rows; `validateCore` rejects a name no layer carries.
- **`once: true` marks a cross-cutting layer** — one task for the whole
  build instead of one per intent (Step 4). It must carry no `{module}`
  in any field, and at least one layer of the core must be without it.
- **`verify` must prove the layer's own claim, not just exit clean.** A
  command that runs but asserts nothing (`tsc --noEmit` alone on a layer
  whose job is behavior, a `test -s` on a file nothing checks the content
  of) passes on an empty implementation. Pair typecheck/build commands
  with a test command that exercises the layer's actual output whenever
  the layer produces behavior, not just types.
- **A `verify` filter token must cross-check against that same layer's
  `scope`.** When `verify` includes a test-runner filter string (`pnpm
  test <token>`, `pnpm test <token1> <token2> ...`), each token is a
  claim that some file matching the layer's own `scope` globs exists and
  will run under that filter. Neither the loader nor the test runner
  checks this — a token with zero matching scope paths is a silent
  no-op (the runner contributes zero tests for a filter that matches
  nothing rather than failing on an empty match set), and a scope-listed
  test file with no filter token covering it never runs at all under
  `verify`, both invisible until `hedgehog verify` rejects a legitimate
  file as out-of-scope or a coverage gap ships unnoticed. For every
  layer, walk each filter token in `verify` and confirm at least one
  path in that layer's `scope` list would match it, and walk `scope`'s
  own test-file paths back to confirm each has a covering token — fix
  both directions (add the missing scope path, or add the missing
  filter token) before Step 6, not after a build discovers the gap live.

Verify the file loads before showing it back, by calling the loader
directly:

```bash
node -e "import('./src/db/core.mjs').then(m => m.loadCore('.hedgehog/core.yaml')).then(c => console.log(JSON.stringify(c, null, 2)))"
```

Read the layers it prints back: a field the parser dropped shows up as an
empty string or `[]` there, and a `{module}` you meant to include is
visible in the globs or absent from them. A `core.yaml` that throws at
load time is the one failure mode that strands a project with no path
forward. The loader only confirms the file parses — it does not run the
filter/scope cross-check above, so do that by hand against this printed
output before moving on.

## Step 6 — write `.hedgehog/core-design.md`

The rationale the engine doesn't read but the project needs: the system
shape and why, the stack and why (the default it came from, or the named
constraint that justified a substitution), the composition/error/config/
entrypoint decisions from Step 2, the layer blueprint used and what
changed from it (or, off-table, that layers were derived directly and
why), the layers with a line each on what they own and why they sit where
they do, the module-axis decision, and anything left unresolved. Written
once, archival, never edited after — the same stance `.hedgehog/BMAD/`
takes. Later changes to the architecture are Correction Protocol entries
in the commit log, not edits here.

## Confirm & Lock

Authoring a core is the most consequential decision in a Hedgehog project
— every task the graph ever compiles walks this sequence — and it's cheap
to change only until the file lands. Hard stop.

🔒 **Confirm & Lock**. Show, in full, not condensed:

- The system shape, in the one line from step 1.
- The stack: language, package manager, and named framework(s), plus
  whether it's the shape's default or a substitution — and if a
  substitution, the one-line constraint that justified it.
- Each layer in order: what it owns, its scope globs, its verify command,
  its commit message — each verify command's filter tokens already
  cross-checked against that same layer's scope globs (Step 5).
- The module-axis decision, named as such, with the consequence stated
  (intents × layers tasks, or one task per layer).
- That this is an authored core: the sequence was designed for this
  project, not battle-tested across many, and it carries the same
  enforcement as a Golden Core but a weaker guarantee.

Then state plainly what happens on confirmation, before it happens:

> This writes `.hedgehog/core.yaml` and `.hedgehog/core-design.md`, then
> planning intake mines the PRD into intents against this layer sequence.
> Every task this project ever builds walks these layers in this order.
> Anything wrong — say so now; it's a normal edit before this point, and
> a Correction Protocol entry after. Confirm to proceed, or tell me what
> to change.

Wait for an explicit go-ahead. A revision here is another design pass —
update the draft, re-run this stage, write nothing until the confirmation
holds. Once confirmed and written, control returns to `planner`, which
runs `hedgehog-planning-intake`'s Phase 1 mining against this core the
same way it would against a shipped one, then hands off to `bootstrap`.

This skill's job ends at the design artifacts — `core.yaml` and
`core-design.md` are text, written by editing files. `hedgehog init`
lands the shared agents/skills/build-graph payload regardless of core, so
the workspace this design describes is still `bootstrap`'s to generate:
`hedgehog-bootstrap-authored-core` runs the stack's own generator and
installs it, a separate step, once Phase 1 mining and Confirm & Lock have
both landed.
