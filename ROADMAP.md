# Roadmap

Where Hedgehog is headed, open for contribution. Read
[CONTRIBUTING.md](CONTRIBUTING.md) first — it defines the rules this repo's
content has to follow (current-state-only files, one owning file per rule,
scoped PRs).

Two tiers below. **Bigger items** are multi-session, some architectural.
**Small items** are each scoped to one file or one narrow addition — a
single sitting, no design discussion required to start. If you've never
contributed to Hedgehog before, start there.

## Bigger items

### A mobile core

The two existing cores with pre-built workspaces (`full-stack-app`,
`landing-page`) are hand-built, pre-verified, and each ships as its own
npm package — reserved for shapes common and opinionated enough to
deserve that treatment. Mobile (React Native or similar) is the strongest
candidate for a third: navigation, offline state, and native build
tooling carry enough real architectural decisions that a
`hedgehog-core-design` blueprint alone won't lock them the way a
pre-built core does. Scope: a new `@skyf0xx/hedgehog-core-mobile`
package, its own repo, carrying a pre-built, pre-verified workspace and a
generator/scaffold layer (see "A generator layer as a quality bar for new
opinionated cores" below), plus a `src/registry/cores.json` entry in this
repo with a `--mobile` install flag and the phase/layer build order that
goes with it — modeled on `@skyf0xx/hedgehog-core-full-stack-app`.

### Add-ons beyond Auth, Queue, and Mobile

`full-stack-app`'s Add-ons step (`hedgehog-bootstrap`) currently offers
three. Payments, transactional email, file storage/uploads, and background
jobs are common enough asks that they'd each justify their own add-on
following the same one-commit-per-step pattern the existing three use. Each
add-on is roughly its own small item once the pattern is followed — see
`src/skills/hedgehog-bootstrap/SKILL.md` for the shape an add-on step takes.

### A public landing page, hosted on GitHub Pages

Hedgehog has no public-facing site — `README.md` is the only front door
right now. A landing page would pitch the discipline (what it is, the
stance in `README.md`, install instructions) to someone who hasn't cloned
the repo yet. Scope: a static site (the `landing-page` core's own
Astro + Tailwind v4 workspace is the natural build tool for this, eating
Hedgehog's own dog food) living outside `src/` — e.g. `site/` — plus a
GitHub Actions workflow that builds and deploys it to GitHub Pages on
push to `master`. Not part of the payload any consuming project copies;
this only serves the project's own public presence.

## Small items (single session, good first contribution)

### New core-design blueprints

`src/skills/hedgehog-core-design/blueprints/` covers nine shapes (CLI,
library/SDK, browser extension, desktop app, game, data pipeline,
bot/agent, compiler/language tool, infra/deploy tool) — each one a single
25–60 line markdown file read at planning intake for a system shape that
isn't `full-stack-app` or `landing-page`. Shapes not yet covered: an MCP
server, a Slack/Discord bot, a monorepo-of-services, a static site
generator plugin. Adding one is scoped to one new file plus a routing
entry — model it on the shortest existing blueprint (`cli.md`) rather
than the longest.

### A generator layer as a quality bar for new opinionated cores

`full-stack-app` is the only core with a scaffold layer of its own —
`workspace/tools/generators/` (Nx generators for schema, contract,
repository, service, controller, hook, and screen), driven by the
`nx-generate` skill instead of an agent writing that boilerplate
freehand. A core proposing a new pre-built workspace (the mobile core
above, or any future one) should propose what it generates alongside the
workspace itself, not add a generator layer later as an afterthought —
this is a first-class part of what makes a core's build order
mechanically enforced rather than convention the AI is asked to follow.
Scope for any single such proposal: identify the repeatable per-module
boilerplate the new core's build order produces, and design the
generator(s) for it modeled on `full-stack-app`'s, as part of the same
PR that proposes the workspace.

### New host support

`src/hosts/` has one directory per coding agent Hedgehog installs into
(`claude/`, `cursor/`, `gemini/`) — each is a `DISPATCH.md` (15–30 lines)
plus that agent's native config format, wired into `capabilities.mjs` and
`routing.mjs`. Windsurf, Copilot CLI/Workspace, and OpenCode are plausible
next hosts. Each is scoped to one new `src/hosts/<name>/` directory and the
corresponding entries in the two `.mjs` files — see `src/hosts/gemini/` for
the smallest existing example to model against.

### Small doc and DX gaps

Anything found while actually using Hedgehog that's a one-file fix: a
missing flag in a `--help` output, a stale cross-reference between an
agent/skill file and `README.md`, an error message that doesn't say what to
do next. File an issue with the concrete repro, or send the fix directly if
it's a single file.

## Contributing to this list

Adding an item here is itself a contribution. Keep new entries scoped the
same way the ones above are: a stated problem, where it lives in the repo,
and what "done" looks like — not a vague direction.
