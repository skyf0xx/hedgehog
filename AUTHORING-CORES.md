# Authoring a core

A core is an npm package: a pre-built, pre-verified workspace plus the
agents, skills, and scaffold scripts that build it.

This repo (the engine) never contains a core's own workspace, agents, or
skills. Those live in the core's own repo and package, released
independently.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the engine resolves and
installs a core, and its per-core tables for what `full-stack-app`,
`pwa-app`, `landing-page`, `authored`, and `adopted` each chose and why.

This doc is the package contract a new core must satisfy, plus the edits
in this repo that make it installable.

## Principle: generators over hand-authored output

When a core's workspace template needs a new piece of repeatable
boilerplate, prefer building or extending a generator over writing that
output by hand.

Generated output is cheaper, faster, and more consistent than an agent
authoring it freehand. Reach for an agent only for parts a generator
can't cover.

A generator costs more up front than one hand-written instance, but pays
that back across every future use.

`hedgehog-core-full-stack-app`'s `workspace/tools/generators/` (an Nx
generator per domain-module layer) is the running example to model new
scaffolding against.

## The package contract

At the package root:

- **`hedgehog-core.yaml`** — the manifest naming the core and where each
  contributed piece lives in the package. Parsed by
  [`src/registry/manifest.mjs`](src/registry/manifest.mjs), whose header
  comment is the authoritative field list:
  - `name` — matches this core's entry in `src/registry/cores.json`.
  - `language`, `template` — required. `template` names the file that
    fills the installed `CLAUDE.md` shell's core section
    (`CLAUDE.core.md`).
  - `workspace` — path to the scaffold (e.g. `workspace/`). Omitted by a
    core that scaffolds nothing (`authored`, `adopted`).
  - `agents`, `skills`, `vendor_skills` — lists naming `agents/<name>.md`,
    `skills/<name>/`, and `vendor-skills/<name>/` inside the package.
  - `engine` — a caret range over a three-part version (e.g. `"^5.0.0"`)
    stating the engine line this core's agents and skills target. A CLI
    *older* than that line refuses the core outright
    (`assertEngineSatisfies` in the same file) rather than landing a
    payload it can't drive. A CLI *newer* than it installs the core and
    prints the skew as an advisory: the engine carries every feature the
    core asks for, so a core one major behind still works while its own
    package catches up.
  - `selects_when` is **not** a manifest field — see below.

- **`core.yaml`** — the layer sequence and per-layer verify commands, in
  the shape `src/db/core.mjs` loads for an authored core. This turns the
  core's build order into something `hedgehog verify` can gate on
  mechanically, rather than a convention an agent is asked to follow.
  A layer may also carry `requires: [<binary>, ...]`, naming a system
  binary — Docker, Terraform, a database CLI — that its `verify` command
  needs beyond what the workspace's package manager installs. JS/TS
  toolchain binaries (vitest, tsc, eslint, nx, …) never need it. Checked
  by `hedgehog status` and `hedgehog verify`; see
  [`src/db/requires.mjs`](src/db/requires.mjs)'s header comment for the
  resolution semantics.

## The loop skill's dispatch step needs a fallback pointer

A core's own loop skill (`hedgehog-loop`, `hedgehog-dsh-loop`,
`hedgehog-landing-loop`, `hedgehog-authored-loop`, or the equivalent in a
new core) has exactly one step that dispatches a claimed packet to a
named subagent (`backend-eng`, `pwa-eng`, `harness-eng`, `landing-builder`,
`layer-eng`, or whatever this core's own build agent is called). That
subagent is installed by this same `init`/`update` call, in the same
session — and Claude Code (per `src/hosts/claude/DISPATCH.md`) registers
agents once, at session start, so a name-based dispatch immediately after
install reports the agent as not found even though its file exists on
disk. This is the default first-build experience, not an edge case: `init`
→ `planner` → `bootstrap` → the loop all naturally happen in one
continuous session.

Root CLAUDE.md already carries the explanation and the workaround (read
the agent's file directly rather than waiting for a session restart) via
`{{HOST_DISPATCH}}`. A core's loop skill doesn't need to restate that
explanation — it needs one sentence at its own dispatch step pointing
back to it, so an agent deep in loop execution doesn't have to
rediscover the fallback on its own or treat the failure as fatal. Model
the wording on the existing cores' loop skills: *"If a dispatch by name
reports the agent as not found — expected right after `init`/`update`
installed it this same session — see root CLAUDE.md's 'Delegating on
this host' note rather than treating it as fatal."*

## Testing a core before it's published

`fetchCore` (`src/registry/fetch.mjs`) normally resolves a core package
from the public npm registry via `npm pack <package>@<version>`. Set
`HEDGEHOG_CORE_SOURCE` to a local directory and it resolves
`<dir>/<package-basename>` instead — a local checkout, unpublished —
which is how a core is exercised end to end before `npm publish` ever
runs.

This still requires a `src/registry/cores.json` entry, since that's the
only thing `init`'s core menu and `plan()` read to find the package name,
version, and flag in the first place — `fetchCore` needs an `entry` to
call `packSpec` on. Add one **temporarily, uncommitted**:

1. In this repo, add a normal-looking entry to `cores.json` — `name`,
   `flag`, `package` (must match the local checkout's own
   `package.json` `name`), any `version` string (unchecked against the
   registry while `HEDGEHOG_CORE_SOURCE` is set), `repository`, and
   `selects_when`.
2. Run a real install against it, with the env var pointed at the
   parent directory of the core's local checkout (not the checkout
   itself):

   ```sh
   HEDGEHOG_CORE_SOURCE=/path/to/parent/dir \
     node bin/cli.mjs init --copywriting
   ```

   in a scratch project directory — never the `hedgehog` repo itself,
   which isn't a valid install target. `npm pack` runs against the
   local checkout's actual committed state, uncommitted edits included,
   so iterate by editing the core repo and re-running `init` (or
   `update`) with no publish step in between.
3. Undo step 1 before committing anything else in this repo:

   ```sh
   git checkout -- src/registry/cores.json
   ```

   (or `git diff src/registry/cores.json` first, if other legitimate
   changes to the file are staged alongside the temporary entry, and
   revert only the added lines by hand). `npm run check`'s registry
   check (`npm view <package> version` against the real registry) fails
   loudly on an entry for a package that was never published — the
   temporary entry must not survive to a commit or a CI run.

`HEDGEHOG_CORE_SOURCE` also works for `update`, so the same pattern
tests a version bump to an already-registered core before it's
published, not just a brand-new core's first install.

## Registering the core

Adding the package to the CLI's `init` menu is one entry in
[`src/registry/cores.json`](src/registry/cores.json): `name`, `package`,
`version` (the range `init` resolves), `flag` (the CLI install flag —
`null`/absent for `authored`, which planning chooses rather than a user
passing it at install time), `repository`, and `selects_when`.

`selects_when` is prose `planner` reads aloud in Phase 0 to choose a
core, before any core package is fetched. That's why it lives in the
registry entry and not the manifest: the registry is the only thing
`planner` has read at that point.

A `selects_when` key inside a core's own `hedgehog-core.yaml` is dropped
on parse and flagged by `scripts/check.mjs` — the registry entry is the
only copy anything reads.

Match the tone and grain of the existing entries in `cores.json`:
concrete signals from the project description, not abstract category
names, plus a call-out of the adjacent core it's most often confused
with.

## Keeping a shipped workspace current

A core that ships a pre-built `workspace/` owns the staleness of its own
dependencies — this repo has no visibility into any core's dependency
tree.

Add a scheduled workflow in the core's own repo that updates its
dependencies as a single reviewable PR. Gate it on that workspace's real
build/test/lint targets, not a stub, and have it open a PR for human
review rather than merge or publish on its own.

See "Keeping a shipped core's workspace current" in
[ARCHITECTURE.md](ARCHITECTURE.md) for the three existing examples
(`full-stack-app`, `pwa-app`, `landing-page`) and why each is shaped the
way it is.

## Authoring checklist

1. Write the core's package: `hedgehog-core.yaml`, `core.yaml`,
   `CLAUDE.core.md`, its `agents/`, `skills/`, optional
   `vendor-skills/`, and optional `workspace/`.
2. If it ships a workspace, build its generators before hand-authoring
   any repeatable scaffolding, and add the dependency-update workflow
   described above.
3. In the loop skill's per-packet dispatch step, add the fallback pointer
   to root CLAUDE.md's "Delegating on this host" note described above.
4. Add the entry to `src/registry/cores.json`, including `selects_when`.
5. Sweep the places that enumerate cores by hand rather than reading the
   registry — `CLAUDE.md` names the full list to update in the same PR.
6. Run `npm run check` — it asserts a manifest's `selects_when` isn't
   silently duplicating the registry's, among other structural checks.

## Auditing an existing core

Use this to check a core already in `src/registry/cores.json` still
satisfies the package contract above.

### `hedgehog-core.yaml`

- [ ] `name` matches the core's entry in `src/registry/cores.json`.
- [ ] `language` and `template` are present; `template` names a file that
      actually exists in the package and fills `CLAUDE.core.md`.
- [ ] `workspace` points at a real path, or is omitted (workspace-less
      cores only).
- [ ] Every name listed under `agents`, `skills`, `vendor_skills`
      resolves to an actual `agents/<name>.md`, `skills/<name>/`, or
      `vendor-skills/<name>/` in the package.
- [ ] `engine` is a caret range that actually reflects the engine
      features this core's agents/skills depend on.
- [ ] No `selects_when` key here (it belongs only in the registry entry
      — `scripts/check.mjs` flags a stray one, but it's worth eyeballing).

### `core.yaml`

- [ ] Layer sequence matches the build order the core's own agents and
      skills actually follow.
- [ ] Each layer's `verify` command is real and runnable, not a stub.
- [ ] `verify_radius` (when set wider than `scope`) and `exclusive: true`
      are declared on the layers that are actually join or integration
      points — this is also where the real test bar and the `reviewer`
      pass land (`hedgehog-authored-loop`'s "Test depth follows verify
      radius"), so the decision made here is the same one that sets test
      and review cadence, not a separate call to make later.
- [ ] Every `verify` command has been checked for a system binary beyond
      what the workspace's package manager installs (Docker, Terraform,
      a database CLI, a compiler toolchain), and any such binary is
      declared in that layer's `requires: [<binary>, ...]`.
      Confirm the exact binary name matches what the command invokes
      (e.g. `docker compose` needs `requires: [docker]`, not
      `docker-compose`).
- [ ] No `requires:` entries for ordinary JS/TS toolchain binaries
      (vitest, tsc, eslint, nx, …) — those don't belong there.

### Loop skill

- [ ] The per-packet dispatch step points back to root CLAUDE.md's
      "Delegating on this host" note for the not-found-on-first-session
      case, per "The loop skill's dispatch step needs a fallback pointer"
      above.

### `src/registry/cores.json` entry

- [ ] `repository` points at the core's actual current repo.
- [ ] `version` range still resolves to a published version of the
      package (`npm run check` catches a stale range against a major/
      minor bump — see CLAUDE.md's Releasing section).
- [ ] `selects_when` still reads as concrete signals from a project
      description, not abstract category names, and still calls out the
      adjacent core it's most often confused with.

### Workspace (if the core ships one)

- [ ] Repeatable scaffolding goes through a generator, not hand-authored
      per use.
- [ ] A scheduled dependency-update workflow exists in the core's own
      repo, gated on real build/test/lint targets, opening a PR rather
      than merging or publishing unattended.

### Cross-repo hygiene

- [ ] `npm run check` passes in this repo.
- [ ] If anything above changed, the places that enumerate cores by hand
      (`CLAUDE.md`, and the other files that repo's own CLAUDE.md names)
      were swept in the same PR.
