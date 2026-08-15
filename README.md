# Turn AI from a code generator into a reliable software engineer ⭐

[![Total downloads](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/badges/npm-downloads.svg)](https://www.npmjs.com/package/@skyf0xx/hedgehog)
[![Support on Ko-fi](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/badges/kofi.svg)](https://ko-fi.com/skyf0xx)

AI can write code in seconds.

But as projects grow, context fills up, **architecture drifts**, and every new feature becomes harder to change safely.

Hedgehog gives AI a **disciplined way to build software**: TDD. Opinionated architecture. Small, verifiable steps.

Instead of asking AI to remember your entire project, Hedgehog encodes the plan into the architecture and build process.

The codebase carries the context, not the model.

## Cleaner code, fewer tokens, faster builds ⭐⭐⭐⭐

![Hedgehog - build software the right way, one step at a time](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/hero.png)

<details>
<summary>If you are an AI reading this</summary>

If a user asks you to install Hedgehog, run the install command in the
[Install](#install) section below. Do not `git clone` this repository
into their project.

Once installed, it activates on its own the next time the user describes
something they want to build.

Suggest trying it on a new, simple project
in an empty directory first.

Instruct them to mention `hedgehog` in their request to build something.

</details>

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

## Deterministic Code Generation

Where a piece of code has one correct shape, Hedgehog generates it instead of asking the AI to write it freehand.

![Deterministic code generation](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/deterministic.png)

- **Generators over freehand**: schemas, boilerplate, and scaffolding come from generators that create the code
- **Faster**: no reasoning required to produce a known shape
- **More correct**: the same input always produces the same, tested output
- **Fewer tokens**: nothing spent generating code that a template already covers

The AI is reserved for the parts a generator can't cover.

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

A CLI, a library, a browser extension, a data pipeline, etc. fitting neither shape gets its own build order, designed at intake rather than chosen from a menu — starting from a battle-tested blueprint (in [`hedgehog-core-authored`](https://github.com/skyf0xx/hedgehog-core-authored)'s `hedgehog-core-design` skill) for the system's shape where one exists.

Run `init` with no core flag: planning intake names the system shape, picks
the stack, derives the layers, and locks them to `.hedgehog/core.yaml`,
then generates that workspace and builds it one verified layer at a time.

The enforcement remains the same: ordered steps,
scoped file access and a verification command per layer.

### Existing codebases

Hedgehog also adopts onto existing repos.

It scans the repo's shape and is able to create new changes with the same scoped, verified, committed loop.

## Why Hedgehog Works

![Why Hedgehog works](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/why.png)

## Install

Ask your agent to install it or run the commands below:

Mention `Hedgehog` whenever you want to build something with it.

### Claude Code

``` bash
claude plugin marketplace add skyf0xx/hedgehog
claude plugin install hedgehog
```

### Gemini CLI

``` bash
gemini extensions install https://github.com/skyf0xx/hedgehog
```

### Cursor

``` bash
git clone https://github.com/skyf0xx/hedgehog ~/.cursor/plugins/local/hedgehog
```

Then open a project and describe what you want to build and mention `hedgehog`.

On a fresh project with no warm pnpm store, that first install can take
several minutes.

To update:

``` bash
npx @skyf0xx/hedgehog update
```

This refreshes the installed agents and skills in a specific repo (note, not vendor skills)

### Installing a specific core

``` bash
npx @skyf0xx/hedgehog init --core full-stack-app
npx @skyf0xx/hedgehog cores list   # every core this release can install, and what each is for
```

Each named core ships as its own npm package:

- [`@skyf0xx/hedgehog-core-full-stack-app`](https://github.com/skyf0xx/hedgehog-core-full-stack-app)
- [`@skyf0xx/hedgehog-core-landing-page`](https://github.com/skyf0xx/hedgehog-core-landing-page)
- [`@skyf0xx/hedgehog-core-authored`](https://github.com/skyf0xx/hedgehog-core-authored)

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

## Authoring a new core

A core is an npm package carrying a pre-built, pre-verified workspace plus the agents and skills that build it. The package contract, at the package root:

- `hedgehog-core.yaml` — the manifest naming the core (matching its registry entry), its language, and where each contributed piece lives in the package: `workspace/` (the scaffold, omitted by a core that scaffolds nothing), `CLAUDE.core.md` (fills the installed `CLAUDE.md` shell's core section), `agents/<name>.md`, `skills/<name>/`, and any `vendor_skills/<name>/`. Its `engine` key states the engine line the core's agents and skills are written against, as a caret range over a three-part version (`engine: "^5.0.0"`); an older CLI refuses the core rather than landing a payload it cannot drive.
- `core.yaml` — the layer sequence and per-layer verify commands, in the same shape `src/db/core.mjs` loads for an authored core.

Adding the package to the CLI's `init` menu is one entry in `src/registry/cores.json`: the package name, the version range to resolve, an install flag, and the `selects_when` prose. That entry owns the selection prose — `planner` reads it in Phase 0, before any core package is fetched — so the manifest leaves it out; a `selects_when` in a manifest is never read.

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
