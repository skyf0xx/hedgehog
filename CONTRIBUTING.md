# Contributing

Hedgehog is a package of agents and skills. This repo's content — everything
under `src/`, plus `README.md` — is the product a consuming project installs.
Contributing means editing that discipline directly, not building around it.

Looking for something to work on? See [ROADMAP.md](ROADMAP.md) — it's split
into bigger, multi-session items and small, single-session items scoped to
one file. The `hedgehog-contributing` skill
(`src/skills/hedgehog-contributing/SKILL.md`) walks through branching,
committing, and opening a PR for either kind, and `tweaker` offers it
directly at the end of a build.

You're also welcome to pick up any open issue labeled
[`help wanted`](https://github.com/skyf0xx/hedgehog/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).

## Before you start

Read `CLAUDE.md` at the repo root. It defines the rules this content has to
follow:

- Every file states current state only. No "we used to do X," no changelog
  narration inside the content itself — that belongs in commit messages and
  PR descriptions.
- Every rule an agent or skill depends on lives inside that agent or skill
  file, or in `README.md`. Nothing load-bearing lives in a separate reference
  doc, because a consuming project copies `src/agents/` and `src/skills/`
  verbatim.
- A fact restated across multiple agents/skills (e.g. commit-message format,
  the domain module shape) has exactly one owning file. Others reference it
  by name instead of restating it.

## Making changes

1. **Agents** (`src/agents/`) and **skills** (`src/skills/*/SKILL.md`) are
   the payload. Edit them directly for behavior changes.
2. **Templates** (`src/templates/`) are files a consuming project copies and
   then edits or deletes — `CLAUDE.md`, `TODO.md`, the starter
   `package.json`. Keep placeholders generic; they're filled in per-project
   at Intake by the `planner` agent.
3. **The installer** (`bin/cli.mjs`) copies the payload and templates into a
   target repo. Change it when the payload's shape changes (new agent, new
   skill directory, new template file) — the `PLAN` array must match.
4. Verify the install path locally before opening a PR:

   ```bash
   mkdir -p /tmp/hedgehog-smoke && cd /tmp/hedgehog-smoke
   node /path/to/hedgehog/bin/cli.mjs init
   ```

   Confirm `.claude/agents/`, `.claude/skills/`, and the root templates land
   correctly.

## Stack changes

Each core locks its own stack, in its own repo — `full-stack-app`'s,
`pwa-app`'s, `landing-page`'s, `copywriting`'s, and `deepseek-harness`'s
tables live in `ARCHITECTURE.md` here, but the workspace, agents, and
skills that implement them live in that core's own npm package
(`hedgehog-core-full-stack-app`, `hedgehog-core-pwa-app`,
`hedgehog-core-landing-page`, `hedgehog-core-copywriting`,
`hedgehog-core-deepseek-harness`).
A stack is locked because it's what makes that core's build order
mechanically enforced (Nx boundaries, phase gates, lefthook) rather than
a convention the AI is asked to follow. Proposing a stack swap for an
existing core means proposing an equivalent enforcement mechanism in the
new tooling, not just a preference, and lands as a PR against that core's
own repo rather than this one. `authored` has no locked stack table —
`hedgehog-core-design` picks the stack per project instead. `adopted` has
none either — `hedgehog-adopt` works with whatever stack the existing
repo already has, as-is.

When a core's own workspace template needs a new piece of repeatable
boilerplate — a new module shape, a new generated file type — prefer
building or extending a generator over hand-authoring the output once.
Building the generator costs more up front than writing the one-off by
hand, but pays that back many times over across every future use of that
generator; this repo's own `CLAUDE.md` states the same rule for the
engine's own `src/`. `hedgehog-core-full-stack-app`'s
`workspace/tools/generators/` (Nx generators for every domain-module
layer) is the concrete, running example to model new scaffolding
against — for a fix in a core repo, not this one.

## Improving a core

A core's own workspace, agents, and skills live in that core's own repo,
not this one — see [`src/registry/cores.json`](src/registry/cores.json)
for the full list and each core's `repository` link. To fix or improve a
core, open a PR against that core's repo directly, then link the PR in
an issue on this repo so it's discoverable from here too.

## Testing policy

A bug fix in `src/db/` or `bin/cli.mjs` ships with a reproduction under
`repro/` that fails against the old behavior and passes against the fix —
that reproduction is the evidence the bug is actually gone, not just
believed gone. Name the file for the bug it reproduces (see the existing
files in `repro/` for the convention) and keep it hermetic: it builds its
own throwaway project under a temp directory rather than depending on
another reproduction's state. `npm run repro` runs every reproduction in
the directory and is part of `.github/workflows/check.yml`'s gate on every
PR, alongside `npm run check` (payload integrity — frontmatter,
cross-references, the core registry) and `eslint .` (linting).

A change to `src/agents/` or `src/skills/` — content rather than
behavior — doesn't need a reproduction; `npm run check` already validates
its shape, and the content itself is reviewed for correctness the way
prose is.

## Commit style

This repo follows Conventional Commits — see the `conventional-commits`
skill (`src/skills/conventional-commits/SKILL.md`) for the format it expects
consuming projects to produce. Apply the same format to commits in this repo.

## Opening a PR

- Keep PRs scoped to one agent, one skill, or one template at a time where
  possible — it mirrors the small-step discipline Hedgehog itself enforces.
- Describe the *why* in the PR description, not in the file you're changing.
- License: MIT.
