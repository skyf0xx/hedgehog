# Attribution

This directory vendors a subset of [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD)
(`bmad-code-org/BMAD-METHOD`), MIT-licensed. See `LICENSE` in this directory
for the full license text.

- **Source repo:** https://github.com/bmad-code-org/BMAD-METHOD
- **Vendored from:** tag `v6.12.1`, commit `790dae9c8e2a1d73575cb2d40b14dd4963391f29`
- **Vendored on:** 2026-10-10
- **Module:** `bmm` (BMAD Method Module)

## What's vendored

Eight skills from BMAD-METHOD's planning shelf, plus the two shared scripts
they depend on:

- `core-skills/bmad-forge-idea`
- `core-skills/bmad-brainstorming`
- `core-skills/bmad-advanced-elicitation`
- `core-skills/bmad-deep-recon`
- `bmm-skills/plan/bmad-product-brief`
- `bmm-skills/plan/bmad-prfaq`
- `bmm-skills/plan/bmad-prd`
- `bmm-skills/plan/bmad-ux`
- `scripts/memlog.py`, `scripts/resolve_customization.py` (shared utilities
  every vendored skill calls, originally at `src/scripts/` in the source
  repo)

Upstream keeps the four `bmm-skills` above under a single flat
`bmm-skills/plan/` directory, collapsed out of the numbered
`1-analysis/` and `2-plan-workflows/` directories an earlier pass found
them in. `bmad-deep-recon` is in the pinned tag, so this pass pins to a
release tag rather than a `main` commit SHA.

`bmad-forge-idea` is a persona-driven interrogation skill that
pressure-tests an idea before any artifact gets written, run ahead of
`bmad-brainstorming` as the shelf's first step. It carries its own
script, `scripts/resolve_personas.py`, vendored alongside it (not shared
— only this skill calls it). Its upstream counterpart `bmad-party-mode`
(the multi-agent roster it can optionally draw on) is not vendored, since
a real roster needs BMAD's own `bmm-skills/agents/bmad-agent-*` persona
skills too — a parallel system to Hedgehog's own `src/agents/`, out of
scope here. `bmad-forge-idea` degrades gracefully without it:
`resolve_personas.py` returns an empty roster and the skill falls back to
generating personas on the fly, which is its documented normal path, not
a degraded one.

Each skill directory carries its own templates, reference files, and
scripts as vendored, unmodified except where noted below.

`scripts/resolve_customization.py` resolves the project root by checking,
in order, the working directory, the script's own install path, and the
invoking skill's directory — preferring any ancestor holding `_bmad/`
over one merely holding `.git` at every depth — and warns on stderr when
a candidate root it didn't pick has an override the chosen root lacks.
This keeps a skill installed outside the target project (e.g. one that
would otherwise walk up to `~`) from landing on the wrong root and
silently missing the project's own override.

## What's stripped

BMAD-METHOD's own orchestration layer is not vendored and is removed from
every skill file that referenced it:

- Central config resolution (`_bmad/scripts/resolve_config.py`,
  `_bmad/scripts/config_utils.py`, `_bmad/config.toml`,
  `_bmad/bmm/config.yaml`) — replaced with trivial defaults inline in
  each skill. Upstream's `plan/` skills call `resolve_config.py` for
  this; re-apply the same strip to whatever call shape upstream uses on
  each re-vendor pass.
- `bmad-party-mode` (multi-agent roster) mentions and invocations.
- Chain-forward "common next skill" suggestions and `bmad-help` routing.
- Misroute-detection logic pointing at non-vendored BMAD skills.

`{bmad-root}` is introduced as a convention across the vendored files,
meaning this directory (`vendor-skills/BMAD/`) — used to address the shared
scripts (`{bmad-root}/scripts/memlog.py`, etc.) without reaching outside
this vendored tree.

## Local changes (not upstream)

- `core-skills/bmad-brainstorming/customize.toml` and
  `core-skills/bmad-brainstorming/references/{mode-autonomous,finalize}.md`
  carry a `keepsake_format` workflow key (`"html"` default,
  `"markdown-only"` opt-out) not present upstream: Ideate-for-me and
  headless mode otherwise auto-generate an HTML keepsake with no way to
  opt out in advance, which is unwanted work on a project whose
  deliverables are markdown/prose only (skyf0xx/hedgehog#386). A
  re-vendor pass must re-apply this key to the freshly-fetched files
  rather than letting it silently disappear.
- `persistent_facts` in every vendored `customize.toml` that carries it
  (`bmad-forge-idea`, `bmad-brainstorming`, `bmad-product-brief`,
  `bmad-prfaq`, `bmad-prd`, `bmad-ux`) defaults to
  `["file:{project-root}/**/project-context.md"]`, not upstream's empty
  default. Upstream moved repo-wide context to a hand-maintained
  `AGENTS.md` loaded via `bmad-project-context`, a skill not vendored
  here; Hedgehog's planning intake instead relies on project context
  flowing into these skills automatically, so requiring a consuming
  project to discover and set an opt-in override just to keep that
  behavior would be a regression. A re-vendor pass must re-apply this
  non-empty default to the freshly-fetched `customize.toml` files rather
  than letting it silently reset to empty.

## Re-vendoring

Pinned deliberately. Re-vendoring against a newer BMAD-METHOD commit is a
manual act: repeat the fetch against the new ref, re-apply the strip step
above, re-apply "Local changes" above, and update this file's pinned
commit and date.
