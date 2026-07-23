# Hedgehog (this repo)

Hedgehog is a build discipline for AI-guided software projects. This repo
holds the discipline itself as a package of Claude Code agents and
skills — the executable payload a consuming project copies in to work
Hedgehog-style, and is the source of the method. See `README.md` for the
discipline's stance and rationale.

## Layout

- `src/agents/` — the subagent roles a consuming project copies into its
  own `.claude/agents/`: `planner` (planning intake, module scoping),
  `bootstrap` (Bootstrap step sequencing), `ux-planner` (Phase B UX
  rationale), `ui-builder` (frontend build steps), `reviewer` (phase
  transition checks, Correction Protocol review). Scoped to the judgment
  calls mechanical gates can't make on their own — deliberately not a
  full agent roster, since the build loop itself is single-agent by
  design.
- `src/skills/` — the packaged procedures a consuming project copies into
  its own `.claude/skills/`:
  - `hedgehog-bootstrap-core` — lands the always-on core workspace (Nx,
    enforcement config, `packages/db`, `apps/api`, `apps/web`) from a
    pre-built, pre-verified template, one pass, before any add-on step.
  - `hedgehog-bootstrap` — scaffolds whichever add-ons (Auth, Queue,
    Mobile) planning intake turned on, one commit per step, after core
    has landed.
  - `hedgehog-planning-intake` — runs the vendored BMAD-METHOD planning
    shelf (`skills/BMAD/`) and mines its output into scope boundary,
    domain modules, and the Add-ons decision. Invoked by `planner`.
  - `hedgehog-loop` — the operating loop for every unit of work once
    bootstrap has run: the domain module step sequence, phase rules, and
    Correction Protocol.
  - `conventional-commits` — reconstructs step-shaped, conventional
    commit history when work didn't land cleanly as it went (mainly
    Correction Protocol cleanups).
- `skills/BMAD/` — BMAD-METHOD (`bmad-code-org/BMAD-METHOD`,
  MIT-licensed), vendored in full: the planning shelf
  `hedgehog-planning-intake` runs. See `skills/BMAD/ATTRIBUTION.md` for
  the pinned source commit; re-vendoring is a deliberate act via the
  `bmad-revendor` skill, not automatic.
- `src/templates/` — files a consuming project copies (and then edits or
  deletes) rather than running as-is: `TODO.md`, the live build checklist
  template (including its `## Add-ons` block); and `CLAUDE.md`, the
  project-root guide the installer drops in (project-context placeholders
  the `planner` fills at planning intake, plus the Hedgehog constants —
  stack, layout, rules, skill/agent pointers, and context-management
  guidance).

## Working in this repo

This repo's own content is the product. Changes here are edits to the
discipline itself: agent and skill content under `src/`, `README.md`,
and any shared config or generators the discipline references.

- Every file states current state only — no negation of alternatives, no
  changelog-style narration, no "we used to do X." If a file needs to
  change, edit it to say what's true now.
- Every rule an agent or skill depends on lives inside that agent or
  skill file, or in `README.md` — not in a separate reference document.
  A consuming project copies `agents/` and `skills/` verbatim, so nothing
  load-bearing may live outside them.
- A fact restated across multiple agents/skills (e.g. the commit-message
  format, the domain module shape) has exactly one owning file; others
  reference it by name rather than restating the substance.
