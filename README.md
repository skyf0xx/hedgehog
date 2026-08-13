# Turn AI from a code generator into a reliable software engineer ⭐

[![Total downloads](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/badges/npm-downloads.svg)](https://www.npmjs.com/package/@skyf0xx/hedgehog)

AI can write code in seconds.

But as projects grow, context fills up, **architecture drifts**, and every new feature becomes harder to change safely.

Hedgehog gives AI a **disciplined way to build software**: TDD. Opinionated architecture. Small, verifiable steps.

Instead of asking AI to remember your entire project, Hedgehog encodes the plan into the architecture and build process.

The codebase carries the context, not the model.

## Cleaner code, fewer tokens, faster builds ⭐⭐⭐⭐

![Hedgehog - build software the right way, one step at a time](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/hero.png)

## How it works

Hedgehog combines:

- **BMAD for planning** — turn an idea into a clear brief, requirements, and architecture
- **An opinionated stack** — remove unnecessary technical decisions, and settle the necessary ones once
- **TDD and progressive layering** — build one tested layer at a time
- **Mechanical enforcement** — use tooling and phase gates instead of trusting the AI to follow instructions
- **Small context loops** — keep every change focused, verifiable, and easy to review

Software that stays structured as it grows.

![Just describe what you want](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/handoff.png)

## The Hedgehog Loop

``` text
Plan
  ↓
Bootstrap
  ↓
Build one small, tested layer
  ↓
Verify
  ↓
Repeat
```

The build order is encoded into the project. The AI does not have to remember what comes next. It does not negotiate the architecture. It follows a proven path through the codebase.

![Small steps, big leverage: small context loops, continuous verification, traceable evolution, sustainable velocity](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/small-steps.png)

## Your build order is a graph

**Every task** Hedgehog generates **is a node** with [explicit dependencies in sqlite](BUILD_GRAPH.md).

Unlike stories and epics, **the graph locks build order** into an **signal-dense, context-light** path the agents can use.

```bash
npx @skyf0xx/hedgehog graph # show graph
```

![The Hedgehog build graph](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/graph.png)

## Parallel by Default

Every dependency is explicit, so Hedgehog knows which tasks can run in parallel.

![Comparison](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/comparison.png)

Agents fan out to give you great outcomes at **faster speeds**.

## What Hedgehog builds

### Full-stack applications

A fixed TypeScript stack with a backend-first, test-driven build order:

``` text
Schema
  ↓
Contract
  ↓
Repository
  ↓
Service
  ↓
Controller
  ↓
UI
```

Every layer is verified before the next begins.

### Landing pages

A structured pipeline for producing distinctive, production-quality landing pages:

``` text
Brief
  ↓
Feeling
  ↓
Design tokens
  ↓
Sequence
  ↓
Artifact
```

### Anything else

A CLI, a library, a browser extension, a data pipeline, etc. fitting neither shape gets its own build order, designed at intake rather than chosen from a menu — starting from a [battle-tested blueprint](src/skills/hedgehog-core-design/blueprints) for the system's shape where one exists.

Run `init` with no core flag: planning intake names the system shape, picks
the stack, derives the layers, and locks them to `.hedgehog/core.yaml`,
then generates that workspace and builds it one verified layer at a time.

The enforcement remains the same: ordered steps,
scoped file access and a verification command per layer.

## Why Hedgehog Works

![Why Hedgehog works](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/why.png)

## Install

From an empty project folder, ask Claude or your Agent to run:

``` bash
# Full-stack app
npx @skyf0xx/hedgehog init --ts-full-stack-app

# Landing page
npx @skyf0xx/hedgehog init --landing-page

# Anything else (CLI, library, browser extension, data pipeline, etc.)
npx @skyf0xx/hedgehog init
```

Then open your coding agent and describe what you want to build.

The golden cores print a `pnpm install` step as part of their next steps.
On a fresh project with no warm pnpm store, that first install can take
several minutes — it's pulling a full monorepo toolchain (Nx, webpack,
sass-embedded, Playwright, etc.) and, on first commit, running the commit
gate against the whole workspace. A quiet stretch of output during that
step is expected, not a hang.

### Coding agents

Hedgehog installs for **Claude Code** by default. Add a host flag to
install for another one, or several at once:

``` bash
npx @skyf0xx/hedgehog init --cursor              # Cursor
npx @skyf0xx/hedgehog init --gemini              # Gemini CLI
npx @skyf0xx/hedgehog init --host=claude,cursor  # both
npx @skyf0xx/hedgehog init --all-hosts           # every supported agent
```

Each one gets the discipline in its own native shape — agents and skills
in the directory it reads, and the instructions file it loads at session
start (`CLAUDE.md`, `HEDGEHOG.md`, or `GEMINI.md`).

To update:

``` bash
npx @skyf0xx/hedgehog update
```

This refreshes the installed agents and skills — for every coding agent
the project was set up for — along with the `AGENTS.md` index derived
from them. It never touches the instructions file, the build graph, the
core workspace, or `vendor-skills/BMAD`, since those carry project-specific or
write-once content.

## Why Hedgehog

Most AI coding tools improve prompting.

Hedgehog improves the **system AI builds inside**.

| | Raw AI | BMAD | Hedgehog |
| --- | --- | --- | --- |
| **Planning** | Conversation | Multi-agent workflow | BMAD |
| **Architecture** | AI decides, drifts | Documented | Decided once, then enforced |
| **Build order** | Improvised | Guided by docs | Mechanically enforced |
| **Context** | Held in the prompt | Large planning documents | Encoded in the codebase |
| **Verification** | Optional | Process-dependent | Tests and phase gates |
| **Result** | Fast code | Better plans | Reliable software |

## Architecture

Hedgehog uses a fixed stack and build order for each core. The tooling enforces architectural boundaries so correctness does not depend on the AI remembering instructions.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## Credits

Hedgehog uses [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD)
(`bmad-code-org/BMAD-METHOD`) for planning, MIT-licensed.

The `nx-generate`, `nx-run-tasks`, `nx-workspace`, and
`link-workspace-packages` skills are adapted from
[nx-ai-agents-config](https://github.com/nrwl/nx-ai-agents-config)
(`nrwl/nx-ai-agents-config`), MIT-licensed, rewritten for Hedgehog's
pnpm-only workspace convention.

`front-end-eng`'s animation skills (`vendor-skills/GSAP/`) are vendored from
[gsap-skills](https://github.com/greensock/gsap-skills)
(`greensock/gsap-skills`), MIT-licensed.

## Support Hedgehog

If Hedgehog helps you build better software with AI, give it a ⭐ on GitHub.

[![GitHub stars](https://img.shields.io/github/stars/skyf0xx/hedgehog?style=social)](https://github.com/skyf0xx/hedgehog/stargazers)
