# Hedgehog (this repo)

Hedgehog is a build discipline for AI-guided software projects. This repo
holds the discipline itself as a package of Claude Code agents and
skills — the executable payload a consuming project copies in to work
Hedgehog-style, and is the source of the method. See `README.md` for the
discipline's stance and rationale.

This repo is the engine: the CLI, the build graph, the host adapters, the
core registry, and the agents and skills every core shares. Each core —
`full-stack-app`, `pwa-app`, `landing-page`, `deepseek-harness`, and
`authored` (brownfield adoption) — ships as its own npm package holding
that core's workspace, agents, skills, and CLAUDE.md section.
`src/registry/cores.json` names them; `init` fetches the one a project asks
for.

## Layout

- `src/agents/` — the subagent roles every core shares, copied into a
  consuming project's own `.claude/agents/`: `planner` (planning intake,
  core selection, module scoping), `bootstrap` (Bootstrap step
  sequencing), `reviewer` (phase and layer transition checks, Correction
  Protocol review), and `tweaker` (post-build tweak requests and
  friction-log-driven Hedgehog issue suggestions). A core's own build
  agents ship in that core's package and install alongside these.
- `src/skills/` — the packaged procedures every core shares, copied into a
  consuming project's own `.claude/skills/`. A core's own loop, bootstrap,
  and reference skills ship in that core's package and install alongside
  these.
  - `hedgehog-planning-intake` — runs the vendored BMAD-METHOD planning
    shelf (`vendor-skills/BMAD/`), shared by every core, and mines its
    output into scope boundary, domain modules, and the Add-ons decision
    on `full-stack-app`. Invoked by `planner`; `landing-page` runs this
    skill's shelf too, then mines the same archive through
    `hedgehog-landing-loop`'s own planning-intake section instead.
  - `conventional-commits` — reconstructs step-shaped, conventional
    commit history when work didn't land cleanly as it went (mainly
    Correction Protocol cleanups).
  - `no-history-in-output` — keeps project-facing documents (root
    CLAUDE.md, `.hedgehog/core-design.md`, specs, READMEs) written as a
    current, as-is snapshot rather than a log of edits or decisions, on
    first generation and every later revision.
  - `hedgehog-code-intelligence-setup` — installs CodeGraphContext into a
    project-owned environment, indexes the repository, and records the
    indexed commit in `.hedgehog/code-intelligence.json`. `init` blocks
    until it has run. The index is refreshed from here too, when `plan` or
    `status` reports it has drifted from HEAD.
  - `hedgehog-contributing` — forking, branching, and PR-opening
    procedure for contributing a fix or `ROADMAP.md` item back to the
    Hedgehog project itself, as opposed to a consuming project's own
    code.
- `src/registry/` — the core table and the fetcher that acts on it.
  `cores.json` names every core, the npm package that ships it, its
  version range, its install flag (absent on `authored`, which is chosen
  during planning rather than at install time), and the prose `planner`
  reads in Phase 0 to pick one; `index.mjs` loads and resolves it by name
  or flag. `manifest.mjs` owns the shape of the `hedgehog-core.yaml` every
  core package carries at its root — which agents, skills, vendored
  shelves, workspace, and CLAUDE.md section that core contributes.
  `fetch.mjs` resolves a core package with `npm pack`, extracts it, and
  caches the extraction at `~/.hedgehog/cores/<name>/<version>/` so a
  repeat install needs no network; `installed.mjs` records which core a
  project installed, so `update` refreshes that core's agents and skills
  from the same package.
- `vendor-skills/BMAD/` — BMAD-METHOD (`bmad-code-org/BMAD-METHOD`,
  MIT-licensed), vendored in full: the planning shelf
  `hedgehog-planning-intake` runs. See `vendor-skills/BMAD/ATTRIBUTION.md`
  for the pinned source commit; re-vendoring is a deliberate act via the
  `bmad-revendor` skill, not automatic.
- `src/templates/` — files a consuming project copies (and then edits or
  deletes) rather than running as-is: `CLAUDE.md`, the project-root guide
  the installer drops in (project-context placeholders the `planner`
  fills at planning intake, plus the Hedgehog constants — stack, layout,
  rules, skill/agent pointers, and context-management guidance). Each
  core package's own `CLAUDE.core.md` fills that shell's
  `{{CORE_SECTION}}` — at install time when `init` names a core, or by
  the matching bootstrap-core skill when `init` ran naming none and the
  shell landed with that placeholder still unfilled. `{{HOST_DISPATCH}}`
  is filled at install time from the chosen host's `DISPATCH.md`.
- `src/db/` — the SQLite build graph a consuming project's Bootstrap
  initializes at `.hedgehog/hedgehog.db`: schema, intents/tasks, `plan`
  (compiles intents into the task graph), `next`/`ready`/`status`/`claim`
  (what to work on and lease it), `verify`/`gate` (close a layer, check a
  phase transition), `friction`, `debt`, `drift`, `boundary`, `why`,
  `overrides`, `conflict`, `commitLock`, `core`, `rebuild`,
  `graph-server` (serves `src/templates/graph.html`'s visualization),
  `community` (the star prompt raised at the first completed intent), and
  `code-intelligence`/`code-intelligence-requires` (the CodeGraphContext
  index behind pre-read context and verify-radius gaps — the latter also
  owns the `init` gate and the HEAD-vs-`indexedSha` freshness check).
  This is the live source of truth every loop skill and its agents query
  and mutate for what's next and what's done.
- `bin/cli.mjs` — the `hedgehog` CLI installed by `npx @skyf0xx/hedgehog`:
  `init` (installer), `core record-adopted` (lands the `authored` core's
  agents/skills and records them for `hedgehog-adopt`, which has no `init`
  step of its own to call from), and the subcommands (`status`, `next`,
  `verify`, `claim`, `intent add`, `plan`, `friction add`/`list`, …) that
  read and write `src/db/`'s build graph.
- `src/hosts/` — one entry per coding agent Hedgehog installs into
  (Claude Code, Cursor, Gemini CLI): where the payload lands, which
  instructions file that agent loads, and how to emit the agent files
  when its format differs from the canonical one. `capabilities.mjs`
  owns the agent → tool-grant fact for hosts that can't register a
  per-agent grant; `routing.mjs` generates the root `AGENTS.md` index
  from the agents' and skills' own frontmatter; `claude-md-merge.mjs`
  safely merges a core's CLAUDE.md section into a repo's hand-written
  root instructions file (adoption case). `version.mjs` owns
  payload-staleness detection: `init` and `update` stamp the version they
  wrote into `.hedgehog/version.json`, and that stamp is compared against
  the newest published release. See
  [ARCHITECTURE.md](ARCHITECTURE.md) for the host table and
  [AUTHORING-CORES.md](AUTHORING-CORES.md) for the package contract a new
  core must satisfy.

- `hooks/` — the Claude Code plugin's `SessionStart` hook, which injects
  the offer gate (when to raise Hedgehog, when to stay silent, how to
  ask) into context at session start rather than leaving that to
  skill-description matching. `session-start` checks for `.hedgehog/`
  and emits no offer gate when it exists, so an already-installed
  project's own payload owns the session; that check is the one place the
  silence rule is enforced. It also reports a stale plugin — the version
  recorded in the install path against the marketplace clone's
  `origin/<branch>` manifest, read locally with no network wait — which
  is independent of that gate and so is the one thing it emits into an
  already-installed project. Updating a plugin takes two commands
  (`claude plugin marketplace update <marketplace>`, then `claude plugin
  update hedgehog@<marketplace>`): the first fetches the new version, the
  second installs it, and `update` resolves only the qualified
  `plugin@marketplace` id — a bare plugin name fails. The notice reads
  the marketplace name from the install path so a fork's own name comes
  through. `hooks.json` (Claude Code) and `hooks-cursor.json`
  (Cursor) register it; `run-hook.cmd` is a cmd/bash polyglot so the hook
  runs on Windows, and hook scripts stay extensionless because Claude
  Code prepends `bash` to any command containing `.sh`. Part of the
  plugin payload, not the npm package — a consuming project installs real
  agents instead.

## Releasing

Two independent version numbers ship from this repo, bumped by different
triggers and never touched by the same automation:

- `package.json`'s `version` — the npm package (`bin/`, `src/`,
  `vendor-skills/`) that `npx @skyf0xx/hedgehog init`/`update` install.
  Bump with `npm run release` (defaults to a patch bump; pass `--
  minor`, `-- major`, or `-- x.y.z` for anything else) for any change
  under those directories — never hand-edit the version field. **Commit
  the bump on the feature branch and let the PR merge it into `master` —
  do not tag or push the tag yourself.**
  `.github/workflows/publish.yml` watches every push to `master` that
  changes `package.json`, diffs the version from before the push (however
  many commits it carries) against after, and when it changed: tags
  `v<version>`, runs `npm publish`, and creates the GitHub release, all on
  the runner's own token. It also carries a `workflow_dispatch` trigger for
  a manual run — there, with no push to read a prior state from, "before"
  is whatever version is currently live on npm, so a manual run still only
  acts when the committed version and the published version actually
  differ. A tag pushed by hand ahead of the merge collides with that
  workflow's own `git push origin "$TAG"` and fails the release (see git
  history around 2026-08-14 for the incident this rule comes from). If a
  tag was pushed by mistake, delete it (`git push origin --delete
  v<version>`) before the PR merges so the workflow can create it fresh,
  pointing at the actual merge commit. `npm run release`
  (`scripts/bump-package-version.mjs`) is the only way to change this
  version: it bumps `package.json`/`package-lock.json` and
  `src/hosts/gemini/gemini-extension.json` together in one step.
  `scripts/check.mjs` gates on the two agreeing, so a bump to only one
  of them fails `npm run check`.
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`'s
  `version` fields (kept identical to each other) — the Claude Code
  plugin (`claude plugin install hedgehog`), whose payload is `skills/`
  (currently just `skills/hedgehog/SKILL.md`) and `hooks/`, not `src/`.
  `.cursor-plugin/plugin.json` and root `gemini-extension.json` each
  carry the same version for the Cursor and Gemini CLI packagings of
  that same payload (root `gemini-extension.json` only — the unrelated
  `src/hosts/gemini/gemini-extension.json` is per-project template
  content versioned by `package.json`'s bump instead). `npm run
  release:plugin` (`scripts/bump-plugin-version.mjs`) is the only way to
  change this version: it bumps all four together — defaults to a patch
  bump; pass `-- minor`, `-- major`, or `-- x.y.z` for anything else.
  Run it in the same PR as the change, for any edit under `skills/`,
  `hooks/`, `.claude-plugin/`, `.cursor-plugin/`, or root
  `gemini-extension.json` itself — that's what
  a `claude plugin marketplace` update check (or Gemini CLI's own
  extension update check) reads to decide a user has a new version to
  pull. The script asserts the four files agree before writing, so a
  prior silent miss surfaces there instead of compounding; `scripts/
  check.mjs` carries the same assertion as a standing gate, so drift
  between releases fails `npm run check` too. No CI bumps or publishes
  this one; it ships by the marketplace or extension registry re-reading
  the repo at whatever commit `master` is on.

Each core package carries a third version, in its own repo and released
from there — a change to a core's workspace, agents, or skills is a
release of that package, not of this one. `src/registry/cores.json` names
the version range `init` resolves for each, so widening a core's range is
the one edit here that a core release calls for — and a core's version
bump is not, on its own, sufficient for `init`/`update` to reach it: a
caret range only resolves within the pinned major (or, below `1.0.0`,
within the pinned minor — `^0.1.0` never resolves to `0.2.0` even after
`0.2.0` ships), so a core crossing that boundary needs its range in
`cores.json` widened and a new `hedgehog` release cut, or every consumer
stays pinned to the old version with no error anywhere (`npm run check`
catches this — it queries each core's actual latest published version
against its pinned range and fails on a mismatch — but the range still
has to be widened by hand, not just left for the next check run to
complain about). Each core repo carries
its own `.github/workflows/publish.yml`, structured the same way as this
repo's: a version bump to that core's own `package.json`, committed and
merged to that repo's own `main`, is the trigger — the workflow diffs the
version before and after the push, and when it changed, tags, publishes
to npm via OIDC trusted publishing, and creates the GitHub release, all
in one job on the runner's own token, exactly as this repo's own
bump-and-merge triggers its own release.

The two versions move independently: a change scoped to `src/` or `bin/`
only bumps `package.json`; a change scoped to `skills/hedgehog/SKILL.md`
only bumps the plugin version; a change touching both (as most
`src/skills/hedgehog-*` fixes end up also touching the top-level
`skills/hedgehog` offer skill) bumps both, in the same PR.

Adding or changing a core in `src/registry/cores.json` also touches a set
of places that enumerate cores by hand rather than reading the registry,
and each one drifts silently if skipped — no error surfaces, the text just
goes stale. Sweep all of them in the same PR as the registry change:
`skills/hedgehog/SKILL.md`, `hooks/session-start`'s gate text, `CLAUDE.md`,
`SECURITY.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `CONTRIBUTING.md`, and the
code comments in `src/registry/` and `src/db/`. `hooks/session-start` is
easy to miss because it isn't under `skills/`, but it ships as part of the
plugin payload and needs the same plugin-version bump as everything else
in this list.

## The star prompt

`src/db/community.mjs` owns the one thing Hedgehog ever asks of the person
using it: a prompt to star and watch the repo, raised by `hedgehog verify`
at the first intent to close every one of its layers — the first point the
user has watched planned work go through the graph and come out verified.

- **Blocking, not advisory.** The prompt is an instruction to the agent,
  not a line of output — the agent running the Loop holds until the user
  answers. Every other notice this CLI prints is advisory; this one isn't.
- **Fires once.** `starred` and `dismissed` are terminal; `later` and an
  unanswered display both re-arm after a cooldown rather than repeating.
  `hedgehog community star --answer <a>` records the answer.
- **WIIFM-framed.** Watching releases is how a user learns their installed
  payload is behind; starring helps the project. Both stated plainly.

State lives in `.hedgehog/community.json`, per project rather than global.

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
- Where a deterministic generator (e.g. an Nx generator or template) can
  produce a piece of code — tests, modules, boilerplate — prefer it over
  having an agent write that code freehand, in cores and
  elsewhere. Generated output is cheaper, faster, and more consistent
  than LLM-authored equivalents; reach for an agent only for the parts a
  generator can't cover. Building the generator costs more up front than
  writing the one-off by hand, but pays that back many times over across
  every future use — treat that up-front cost as worth paying, not a
  reason to skip the generator. When work reveals a repeatable shape that
  has no generator yet, propose building one rather than writing the
  code by hand again.
