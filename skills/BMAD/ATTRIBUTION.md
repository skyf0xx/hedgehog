# Attribution

This directory vendors a subset of [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD)
(`bmad-code-org/BMAD-METHOD`), MIT-licensed. See `LICENSE` in this directory
for the full license text.

- **Source repo:** https://github.com/bmad-code-org/BMAD-METHOD
- **Vendored from:** `main` branch, commit `bb45db4aa4496c69239f9c0629c290fd1b072fc9`
- **Vendored on:** 2026-07-23
- **Module:** `bmm` (BMAD Method Module)

## What's vendored

Seven skills from BMAD-METHOD's planning shelf, plus the two shared scripts
they depend on:

- `core-skills/bmad-brainstorming`
- `core-skills/bmad-advanced-elicitation`
- `core-skills/bmad-deep-recon`
- `bmm-skills/1-analysis/bmad-product-brief`
- `bmm-skills/1-analysis/bmad-prfaq`
- `bmm-skills/2-plan-workflows/bmad-prd`
- `bmm-skills/2-plan-workflows/bmad-ux`
- `scripts/memlog.py`, `scripts/resolve_customization.py` (shared utilities
  every vendored skill calls, originally at `src/scripts/` in the source
  repo)

Each skill directory carries its own templates, reference files, and
scripts as vendored, unmodified except where noted below.

## What's stripped

BMAD-METHOD's own orchestration layer is not vendored and is removed from
every skill file that referenced it:

- Central config resolution (`_bmad/scripts/resolve_config.py`,
  `_bmad/config.toml`, `_bmad/bmm/config.yaml`) — replaced with trivial
  defaults inline in each skill.
- `bmad-party-mode` (multi-agent roster) mentions and invocations.
- Chain-forward "common next skill" suggestions and `bmad-help` routing.
- Misroute-detection logic pointing at non-vendored BMAD skills.

`{bmad-root}` is introduced as a convention across the vendored files,
meaning this directory (`skills/BMAD/`) — used to address the shared
scripts (`{bmad-root}/scripts/memlog.py`, etc.) without reaching outside
this vendored tree.

## Re-vendoring

Pinned deliberately. Re-vendoring against a newer BMAD-METHOD commit is a
manual act: repeat the fetch against the new ref, re-apply the strip step
above, and update this file's pinned commit and date.
