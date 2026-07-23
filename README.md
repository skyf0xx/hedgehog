# The Antidote to AI Spaghetti Code ⭐

[![GitHub stars](https://img.shields.io/github/stars/skyf0xx/hedgehog?style=social)](https://github.com/skyf0xx/hedgehog/stargazers)

AI writes code faster than humans ever could, but **speed without discipline creates chaos**.

**Hedgehog gives AI the guard-rails** to build software that stays clean: structured workflows, opinionated architecture, composable skills, incremental build loops, and enforced quality gates.

**Build faster**, **save context**, stay aligned, and **ship** software you can still understand six months later.

![Hedgehog — build software the right way, one step at a time](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/hero.png)

## Hedgehog gives AI

1. An opinionated stack
2. An enforced build order
3. Agents and skills that make good engineering the default

## Hedgehog's secret to great outcomes

- **Progressive layering:** types → schema → backend → UI, each layer built on a stable one beneath it
- **Small context loops:** decompose work into atomic, verifiable changes
- **Self-documenting architecture:** the codebase carries the context, not the AI
- **Traceable evolution:** decisions are preserved through conventional commits

![Just describe what you want](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/curve.png)

## Why Hedgehog Exists

AI coding starts fast, then breaks down. Context accumulates, prompts get longer, architecture drifts. Eventually, adding one more feature feels dangerous.

Hedgehog's answer: guardrails, not more discipline from the AI.

## Plans Expire. Structure Doesn't

Without a build order enforced mechanically, an AI (or a person) has to carry the whole plan in its head: architecture, sequencing, past decisions, etc. as an ever-growing prompt.

Hedgehog doesn't ask the AI to remember a plan. It makes the plan visible in the structure of the build. The architecture itself guides the next step.

### The AI should never wonder what to do next

Instead of asking AI to hold an entire application in context, Hedgehog turns the build into a sequence of small, deterministic steps.

Each module is built progressively: schema → contract → repository → service → controller. Every step is gated by tests and committed before the next begins.

Backend comes first. Every module gets a working, typed API before any screen is built. The frontend becomes a consumer of stable capabilities, not a parallel source of complexity.

The build order is not something you negotiate with the AI. It is encoded into the process.

![Small steps, big leverage: small context loops, continuous verification, traceable evolution, sustainable velocity](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/small-steps.png)

## The Hedgehog Loop

``` text
Intake — scope boundary + domain vocabulary (planner agent)
  ↓
Bootstrap (once per project)
  ↓
Phase A, per module — schema → contract → repository → service → controller
  ↓
Phase A closes for the module (gated: typecheck, lint, test)
  ↓
Phase B, per module — hook → UX rationale → screen
  ↓
Repeat for the next module or the next step
```


![Why Hedgehog works: a different way to build with AI, comparing traditional AI workflow to Hedgehog](https://raw.githubusercontent.com/skyf0xx/hedgehog/master/docs/images/why.png)

## Installation

From an empty project folder:

``` bash
npx @skyf0xx/hedgehog init
```

Then open Claude Code and describe what you want to build. The
`planner` agent runs Intake first, asking what's in scope and which
add-ons (Auth, Queue, Mobile) you need; once you confirm, it scaffolds
the project itself.

The core workspace — Nx, `packages/config`, `packages/db`, `apps/api`,
`apps/web`, and every enforcement file — lands instantly from a
pre-verified template rather than being generated live; bootstrap then
only runs whichever add-ons Intake determined your project needs.

Or paste the repo URL to your Agent and have it install for you.

## For Builders

Hedgehog brings proven software engineering practices into AI-assisted development.

Once the project brief is defined, Hedgehog takes over the execution: breaking the work into steps, following the build order, validating progress, and keeping decisions traceable.

Under the hood, it applies the practices experienced engineers rely on:

- iterative delivery
- small units of work
- an opinionated stack
- clear architectural boundaries
- ports and adapters
- continuous verification
- conventional commits

AI becomes the builder operating inside those constraints — turning ideas into software without requiring you to manage every implementation detail.

## Architecture

Hedgehog is a package of agents and skills, built on an opinionated stack so the build order above is mechanical and enforced by the tooling itself:

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

## How Hedgehog Compares

Superpowers and BMAD both improve on raw prompting: one gives the AI good habits, the other gives it a planning process. In both, the order of work is a convention the AI can still break.

Hedgehog enforces its build order with tooling instead: Nx module boundaries, commit hooks, phase gates. The order holds because the tooling holds it, not because the AI followed the discipline.

| | Superpowers | BMAD | Hedgehog |
| --- | --- | --- | --- |
| **What it is** | A skills library for Claude Code: brainstorm, plan, TDD, debug, review | A multi-agent planning framework: PM, Architect, Dev, QA personas | A build discipline: fixed stack, enforced module order |
| **Order comes from** | Skill instructions the agent is told to follow | Sequenced documents (brief → PRD → architecture → stories) | Tooling (Nx boundaries, lefthook, phase gate) |
| **Enforcement mechanism** | None. Prompted convention | None. One optional agent-run checklist between phases | Mechanically enforced by Nx boundaries, commit hooks, and the phase gate |
| **Unit of work** | A task, planned in worktree-isolated steps | A story, derived from PRD and architecture docs | A module layer (schema → contract → repo → service → controller → UI) |
| **Stack** | Whatever the project already uses | No stack opinion | One locked stack (Nx, NestJS, Drizzle, ts-rest, Next.js) |
| **Context per step** | As much as the task pulls in | A full brief, PRD, and architecture doc per story | One module layer at a time (e.g. just the repository, just the controller) |
| **Finding a bug** | Search wherever the task touched | Search wherever the story touched | Search one layer, in one module, in a fixed order |
| **Real cost** | No safety net if the model shortcuts its own process | Documentation overhead most solo projects don't need | Less flexibility: the stack and order aren't negotiable |

## Support Hedgehog

If Hedgehog helps you build better AI software, consider giving it a ⭐ on GitHub.

[![GitHub stars](https://img.shields.io/github/stars/skyf0xx/hedgehog?style=social)](https://github.com/skyf0xx/hedgehog/stargazers)