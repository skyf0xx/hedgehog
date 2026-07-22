# Contributing

Hedgehog is a package of agents and skills. This repo's content — everything
under `src/`, plus `README.md` — is the product a consuming project installs.
Contributing means editing that discipline directly, not building around it.

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

The stack in `README.md`'s Architecture table is locked because it's what
makes the build order mechanically enforced (Nx boundaries, phase gates,
lefthook) rather than a convention the AI is asked to follow. Proposing a
stack swap means proposing an equivalent enforcement mechanism in the new
tooling, not just a preference. See `ROADMAP.md` for where stack flexibility
is headed.

## Commit style

This repo follows Conventional Commits — see the `conventional-commits`
skill (`src/skills/conventional-commits/SKILL.md`) for the format it expects
consuming projects to produce. Apply the same format to commits in this repo.

## Opening a PR

- Keep PRs scoped to one agent, one skill, or one template at a time where
  possible — it mirrors the small-step discipline Hedgehog itself enforces.
- Describe the *why* in the PR description, not in the file you're changing.
- License: MIT.
