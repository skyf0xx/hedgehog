# Hedgehog (this repo)

Hedgehog is a build discipline for AI-guided software projects: an
alternative to BMAD/Superpowers-style frameworks. This repo holds the
discipline itself — the docs, skills, and tooling a project imports to
work Hedgehog-style. It is not a project built with Hedgehog; it's the
source of the method.

## Layout

- `docs/hedgehog-principles.md` — what Hedgehog is and its core stance.
- `docs/hedgehog-stack.md` — the locked technology stack.
- `docs/hedgehog-order.md` — the root-first build sequence and module
  definition.
- `docs/hedgehog-logic.md` — the enforcement config (Nx boundaries,
  commit gates, phase gate, env validation) that makes Stack and Order
  mechanically true rather than merely documented.
- `docs/hedgehog-operating-instructions.md` — the payload a consuming
  project's own root `CLAUDE.md` imports or restates. Written from that
  project's perspective, not this repo's.
- `TODO.md` — template for a consuming project's live build checklist.
- `agents/` — the subagent roles a consuming project copies into its own
  `.claude/agents/`. Scoped to what the Loop and mechanical gates
  (`docs/hedgehog-logic.md`) can't decide on their own: `planner` (Intake,
  module scoping), `ui-builder` (Phase B), `reviewer` (Phase Transition
  Checks, Correction Protocol). Deliberately not a full agent roster — the
  Loop is single-agent by design.
- `skills/` — packaged procedures a consuming project copies into its own
  `.claude/skills/`. `hedgehog-bootstrap` runs Project Bootstrap (Order
  steps 1–7) and wires in Logic's enforcement config, once per project.
  `conventional-commits` matches commit granularity to Order's step
  sequence, used mainly for Correction Protocol cleanups.

## Working in this repo

This repo's own content is the product. Changes here are edits to the
discipline itself: doc content, later the skill/agent packaging, and any
shared config or generators the discipline references.

- Every `.md` file states current state only — no negation of rejected
  alternatives, no changelog-style narration, no "we used to think X."
  If a doc needs to change, edit it to say what's true now.
- Vocabulary (principles), Stack, and Order are the three standing-default
  docs. Logic is enforcement config, not a fourth standing default.
  `docs/hedgehog-operating-instructions.md` is payload, not a standing
  default either.
- Keep the four core docs internally consistent — a fact stated in one
  (e.g. module granularity) has exactly one owning doc; others reference
  it rather than restating it.
