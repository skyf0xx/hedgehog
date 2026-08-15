# Architecture

Hedgehog is a package of agents and skills, built on an opinionated stack per core so the build order in the [README](README.md) is mechanical and enforced by the tooling itself.

## Hosts

`src/agents/` and `src/skills/` are the single source of truth for the discipline's content. A **host** is one coding agent Hedgehog installs into, described by an entry in `src/hosts/index.mjs`: where the payload lands, which instructions file that agent loads, and — where its format differs from the canonical one — how to emit it.

| Host | Agents | Skills | Instructions file |
| --- | --- | --- | --- |
| Claude Code | `.claude/agents/` | `.claude/skills/` | `CLAUDE.md` |
| Cursor | `.cursor/agents/` | `.cursor/skills/` | `HEDGEHOG.md` (+ `.cursor/rules/hedgehog.mdc`) |
| Gemini CLI | `.gemini/agents/` | `.gemini/skills/` | `GEMINI.md` (+ `gemini-extension.json`) |

Claude Code reads the canonical files as authored, so its payload is copied verbatim. Hosts that dispatch an untyped subagent carry the role in the prompt instead: `src/hosts/emit.mjs` strips the Claude Code subagent schema (`model`, `color`, `tools`) and restates the tool grant as a line the agent reads, mapped from the capability table in `src/hosts/capabilities.mjs`.

Every install also generates `AGENTS.md` at the repo root from the agents' and skills' own `description` frontmatter — an index of what each role is for and when it applies. Coding agents that read `AGENTS.md` work from that index.

Tool grants are defense in depth. The enforcement is `hedgehog verify`, which checks the touched files against the task packet's ALLOWED SCOPE and gates the commit — so the ordered steps, scoped file access, and per-layer verification hold on every host regardless of what it granted.

## Core resolution

`src/agents/` and `src/skills/` above are shared by every core. Each core's own build agents, skills, and (for `full-stack-app` and `landing-page`) pre-built workspace ship in that core's own npm package rather than in this repo.

`src/registry/cores.json` is the fixed table naming every core: its npm package, the version range `init` resolves, its install flag, and the `selects_when` prose `planner` reads aloud in Phase 0 to choose one. `init` resolves the requested core against that table (`src/registry/index.mjs`), then fetches the package with `npm pack` and extracts it (`src/registry/fetch.mjs`), caching the extraction at `~/.hedgehog/cores/<name>/<version>/` so a repeat install on the same version needs no network. The extracted package carries a `hedgehog-core.yaml` manifest at its root (`src/registry/manifest.mjs`) naming which agents, skills, vendored shelves, workspace, and CLAUDE.md section it contributes; the installer writes those into the consuming project alongside the shared agents and skills above. `installed.mjs` records which core and version a project installed, so `update` refreshes that core from the same package rather than re-resolving the registry.

`authored` carries no install flag — `hedgehog-core-design` chooses it during planning intake rather than a user passing it to `init`, then designs its layer sequence and writes `.hedgehog/core.yaml` directly instead of fetching a pre-built workspace.

## `full-stack-app` core

| Layer | Choice | Why |
| --- | --- | --- |
| Monorepo | Nx | Enforces module boundaries at compile time. |
| Package manager | pnpm | Prevents accidental cross-package dependencies. |
| Backend | NestJS | Modules naturally mirror Hedgehog's build progression. |
| ORM | Drizzle + drizzle-zod | Database schema is the single source of truth. |
| Database | PostgreSQL | Simple, relational, predictable. |
| Local infra | Docker Compose | Postgres/Redis run identically on every machine. |
| Platform | Railway | Infrastructure is available from the first commit. |
| API contract | ts-rest | Contracts are code, not documentation. |
| Validation | Zod | One schema for runtime and compile time. |
| Auth | Better Auth | Secure by default from day one. |
| Data fetching | TanStack Query | UI consumes typed APIs, never implementation details. |
| Web | Next.js + ShadCN + Tailwind | UI remains a thin presentation layer. |
| Mobile | Expo + RN Reusables | Shares contracts and design tokens with web. |
| Jobs | BullMQ + Redis | Async boundaries exist before they're needed. |
| Logging | Pino | Structured logs from the first feature. |
| Linting | ESLint + Prettier | One shared standard across every module. |
| Testing | Vitest + Playwright | Every step is verifiable before progressing. |
| Commits | Conventional Commits | Architectural decisions become permanent history. |
| Observability | Sentry | Failures map cleanly back to module boundaries. |

## `landing-page` core

Every choice below maps to a specific dial or phase in the Chain
Method: nothing here is a default reached for out of habit.

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | Astro | Zero-JS-by-default shell; islands only where interaction is actually needed. |
| Styling | Tailwind v4 (CSS-first) | Config as token layer only, no component library pre-deciding how things look. |
| Animation / pacing | Motion (CSS/transform targets only, no plugins) | Owns per-section pacing and top/heart/base fade timing via `animate()`/`scroll()`/`stagger()`. |
| Scroll feel | Lenis | The "weight and suspension" dial, instead of default browser scroll physics. |
| Copy reveal | SplitType | Line/word/char splitting, makes copy rhythm visible in motion, not just static text. |
| Typefaces | `@fontsource-variable/*` (faces picked per brief) | Self-hosted and pinned, one file per full weight/width axis; no external request, no `system-ui` fallback making the page read as a template. |
| Images | `astro:assets` (`<Image />` / `<Picture />`) | Format conversion, responsive `srcset`, and reserved space to prevent layout shift — built in, no dependency. |
| Signature element & shape construction | CSS `clip-path` / gradients / `border-radius`, or Canvas 2D with formula-driven coordinates (`landing-shapes` skill) | Shapes come from a named, computable rule, never a hand-typed or hand-measured coordinate; zero coordinate-guessing risk, Motion-animatable directly. |
| Icons | Lucide (`@lucide/astro`) | The one pinned, sourced icon set — importing a published icon isn't hand-authoring. |
| Continuous background field | `ogl` (lightweight WebGL) or raw shader | One field spanning the full page height so sections read as windows onto one surface, not stacked blocks. |
| Section boundary treatment | CSS `clip-path` irregular edges + `mix-blend-mode` overlap + negative-margin overlap | Breaks the hard horizontal seam between sections without any new dependency. |
| Texture/grain | CSS `mask-image` + noise pattern | Materiality layer, no SVG filter needed. |
| 3D | React Three Fiber | Only when the subject is genuinely spatial; skipped by default. |
