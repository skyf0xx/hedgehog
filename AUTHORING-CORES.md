# Authoring a core

A core is an npm package carrying a pre-built, pre-verified workspace
plus the agents, skills, and scaffold scripts that build it. This repo
(the engine) never contains a core's own workspace, agents, or skills —
those live in the core's own repo and package, released independently.
See [ARCHITECTURE.md](ARCHITECTURE.md) for how the engine resolves and
installs a core once it exists, and its per-core tables for what
`full-stack-app`, `pwa-app`, `landing-page`, and `authored` each chose
and why.

This doc is the package contract a new core must satisfy, and the two
edits in this repo that make it installable.

## Principle: generators over hand-authored output

Wherever a core's workspace template needs a new piece of repeatable
boilerplate — a new module shape, a new generated file type — prefer
building or extending a generator over writing that output by hand once.
Generated output is cheaper, faster, and more consistent than an agent
authoring the equivalent code freehand; reach for an agent only for the
parts a generator genuinely can't cover. Building the generator costs
more up front than writing the one-off by hand, but pays that back many
times over across every future use — treat that up-front cost as worth
paying, not a reason to skip it.

`hedgehog-core-full-stack-app`'s `workspace/tools/generators/` (an Nx
generator per domain-module layer) is the concrete, running example to
model new scaffolding against.

## The package contract

At the package root:

- **`hedgehog-core.yaml`** — the manifest naming the core and where each
  contributed piece lives in the package. Parsed by
  [`src/registry/manifest.mjs`](src/registry/manifest.mjs); that file's
  header comment is the authoritative field list. In brief:
  - `name` — matches this core's entry in `src/registry/cores.json`.
  - `language`, `template` — required; `template` names the file that
    fills the installed `CLAUDE.md` shell's core section
    (`CLAUDE.core.md`).
  - `template_adopted` — optional second section, for adopting Hedgehog
    into an existing repo rather than scaffolding fresh.
  - `workspace` — path to the scaffold (e.g. `workspace/`), omitted by a
    core that scaffolds nothing (`authored`).
  - `agents`, `skills`, `vendor_skills` — lists naming
    `agents/<name>.md`, `skills/<name>/`, and `vendor-skills/<name>/`
    inside the package.
  - `engine` — a caret range over a three-part version (e.g.
    `"^5.0.0"`), stating the engine line this core's agents and skills
    are written against. An older CLI refuses the core outright
    (`assertEngineSatisfies` in the same file) rather than landing a
    payload it can't drive.
  - `selects_when` is **not** a manifest field — see below.

- **`core.yaml`** — the layer sequence and per-layer verify commands, in
  the shape `src/db/core.mjs` loads for an authored core. This is what
  turns the core's build order into something `hedgehog verify` can gate
  on mechanically, rather than a convention an agent is asked to follow.

## Registering the core

Adding the package to the CLI's `init` menu is one entry in
[`src/registry/cores.json`](src/registry/cores.json): `name`, `package`,
`version` (the range `init` resolves), `flag` (the CLI install flag;
`null`/absent for `authored`, which planning chooses rather than a user
passing at install time), `repository`, and `selects_when`.

`selects_when` is prose `planner` reads aloud in Phase 0 to choose a core
— before any core package is fetched. That's why it lives in the
registry entry and not the manifest: the registry is the only thing
`planner` has read at that point. A `selects_when` key inside a core's
own `hedgehog-core.yaml` is dropped on parse and flagged by
`scripts/check.mjs` — the registry entry is the only copy anything
reads. Look at the four existing entries in `cores.json` for the tone
and grain `selects_when` prose is expected to hit: concrete signals in
the project description, not abstract category names, and an explicit
call-out of the adjacent core it's most often confused with.

## Keeping a shipped workspace current

A core that ships a pre-built `workspace/` owns the staleness of its own
dependencies — this repo has no visibility into any core's dependency
tree. Add a scheduled workflow in the core's own repo that updates its
dependencies as a single reviewable PR, gated on that workspace's real
build/test/lint targets (not a stub), opening a PR for human review
rather than merging or publishing on its own. See "Keeping a shipped
core's workspace current" in [ARCHITECTURE.md](ARCHITECTURE.md) for the
three existing examples (`full-stack-app`, `pwa-app`, `landing-page`)
and why each is shaped the way it is.

## Checklist

1. Write the core's package: `hedgehog-core.yaml`, `core.yaml`,
   `CLAUDE.core.md`, its `agents/`, `skills/`, optional
   `vendor-skills/`, and optional `workspace/`.
2. If it ships a workspace, build its generators before hand-authoring
   any repeatable scaffolding, and add the dependency-update workflow
   described above.
3. Add the entry to `src/registry/cores.json`, including `selects_when`.
4. Sweep the places that enumerate cores by hand rather than reading the
   registry — `CLAUDE.md` names the full list to update in the same PR.
5. Run `npm run check` — it asserts a manifest's `selects_when` isn't
   silently duplicating the registry's, among other structural checks.
