---
name: conventional-commits
description: Use when uncommitted changes need to be split into atomic, conventional commits ordered for review. Triggers on "commit this", "make commits", "clean up commits", "commit the changes". In Hedgehog, each Loop step is already meant to be its own commit — this skill matters most when a Correction Protocol fast-forward touches several steps at once and those fixes need splitting back into per-step commits.
---

# Conventional Commits

Turn uncommitted changes into a series of atomic, conventional commits
ordered for review, using the commit subjects of the installed core.

The installed core owns the build steps: each layer in `.hedgehog/core.yaml`
declares a `commit` subject, and `hedgehog core show` prints the layer
sequence with those subjects in build order. `hedgehog verify <task-id>`
commits a task under its layer's subject. Read step names and order from
there; the names in this skill's examples come from one core
(`full-stack-app`) and illustrate the shape only.

## When this runs

Normally the Loop commits one step at a time as it goes, in the core's
layer order, so there's nothing to clean up.
This skill is for when that didn't happen cleanly:

- A **Correction Protocol** fix touched an upstream step and several
  fast-forwarded dependents in one working-tree pass, needing to land as
  separate commits (one per step, per the Correction Protocol in
  `hedgehog-orchestrating`).
- Work happened outside the Loop's discipline (exploratory changes, a
  session that didn't commit as it went) and needs reconstructing into
  the step-shaped history Hedgehog expects.

## What "atomic" means here

One commit = one build step, where that applies (one layer of one module)
— not one file. A single step may span several files (for example, a
schema + its migration, or a service + its test).
If work doesn't map onto a build step (tooling, config, docs), fall back
to normal atomic-commit judgment: one logical change per commit.

If a hunk can be removed without breaking the others in its commit, it
belongs in its own commit.

## Steps

### 1. Survey the working tree

Run in parallel:
- `git status` (no `-uall`)
- `git diff` (unstaged)
- `git diff --staged` (anything pre-staged)
- `git log -10 --oneline` to confirm the project's existing commit style
- Run `hedgehog status` for which steps/modules are in flight

Read every changed file's diff fully before grouping — you cannot group
changes you haven't read.

### 2. Group hunks into logical commits

For each hunk, ask: *which build step is this part of, for which module?*
Group by step first, module second. In a core with `schema` and `repository` layers, a hunk in the `orders`
schema and a hunk in the `orders` repository are different commits even
though both are "orders" — different steps.

Group together: a schema change with its migration; a service with its
unit test (tests land with the step they test, not a trailing "add
tests" commit); config/tooling changes (hooks, lint boundaries, env
schema) isolated from any domain step.

Keep separate: different build steps, even for the same module; a
Correction Protocol fix from the unrelated new work it landed alongside;
different modules' changes.

### 3. Order the commits for review

1. **Build-sequence order.** The core's layer order from `hedgehog core
   show` (each layer's `depends_on` chain) — the same dependency order
   the Loop builds in. In `full-stack-app` that is schema, contract,
   repository, service, controller.
2. **Upstream fix before its fast-forwarded dependents**, for a
   Correction Protocol cleanup — the fix commit needs to make sense
   before the commits that changed because of it.
3. **Mechanical before novel.** Config, generated files, renames first.

### 4. Propose the plan, then execute

Output the plan as a numbered list using the core's commit subjects before
committing anything (example from `full-stack-app`):

```
feat(orders): schema
feat(orders): contract
fix(orders): correct FK-by-ID reference dropped in schema step
feat(orders): repository
```

Then execute each commit:
- Stage exactly the hunks for that commit. Use `git add <path>` for a
  whole file; for partial-file staging, write a patch and
  `git apply --cached` it.
- Verify with `git diff --staged` that only the intended hunks are
  staged.
- Commit with the conventional message.
- Verify clean state with `git status` before the next commit.

If a pre-commit hook (the project's typecheck/lint/test gate) fails: fix the
issue, re-stage, create a NEW commit — a commit that fails the gate did
not happen, so amending would rewrite the wrong thing (see Hard rules).

### 5. Commit format

```
<type>(<scope>): <subject>
```

- **type**: `feat` for build steps; also `fix`, `chore`, `docs`,
  `refactor`, `style`, `test`, `build`, `ci`, `perf` as needed.
- **scope**: the domain module name (`orders`, `users`, ...) for a build
  step, or an infra area (`db`, `contracts`, `auth`, `hooks`, `api`,
  `worker`, `web`, `mobile`, `config`) for bootstrap/tooling commits.
- **subject** for a build step: the layer's `commit` subject from the
  installed core's `core.yaml`, with `{module}` filled in (`full-stack-app`
  example: `schema`, `contract`, `repository`, `service`, `api`), matching
  it exactly. For non-step commits, imperative and lowercase, under ~70
  chars.
- Body only when the *why* is non-obvious — for a Correction Protocol
  commit, the body is the explanation ("the commit messages are the
  explanation").

### 6. Hard rules

- Never push. Commits only.
- Never `git add -A` or `git add .` — specific paths or hunks only.
- Never amend. Always new commits.
- Never `--no-verify` — a failing gate means the step isn't done, not
  that the gate is wrong.
- Never commit files that look like secrets (`.env`, `credentials.*`,
  `*.pem`). Flag and skip.
- Never include `Co-Authored-By: Claude` or any AI attribution trailer.
- Working tree clean: say so and stop.
- Changes are genuinely one step: one commit is correct, don't split for
  its own sake.

### 7. When you're unsure how to split

If two hunks could plausibly belong to the same step or different steps,
ask the user once with the proposed plan and an alternative — the full
plan, not per-hunk.
