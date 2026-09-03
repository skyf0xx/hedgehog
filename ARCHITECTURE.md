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

`src/agents/` and `src/skills/` above are shared by every core. Each core's own build agents, skills, and (for `full-stack-app`, `pwa-app`, `landing-page`, `copywriting`, and `deepseek-harness`) pre-built workspace ship in that core's own npm package rather than in this repo.

`src/registry/cores.json` is the fixed table naming every core: its npm package, the version range `init` resolves, its install flag, its GitHub repository, and the `selects_when` prose `planner` reads aloud in Phase 0 to choose one. `init` resolves the requested core against that table (`src/registry/index.mjs`), then fetches the package with `npm pack` and extracts it (`src/registry/fetch.mjs`), caching the extraction at `~/.hedgehog/cores/<name>/<version>/` so a repeat install on the same version needs no network. The extracted package carries a `hedgehog-core.yaml` manifest at its root (`src/registry/manifest.mjs`) naming which agents, skills, vendored shelves, workspace, and CLAUDE.md section it contributes; the installer writes those into the consuming project alongside the shared agents and skills above. `installed.mjs` records which core and version a project installed, so `update` refreshes that core from the same package rather than re-resolving the registry.

`authored` carries no install flag — `hedgehog-core-design` chooses it during planning intake rather than a user passing it to `init`, then designs its layer sequence and writes `.hedgehog/core.yaml` directly instead of fetching a pre-built workspace.

### Keeping a shipped core's workspace current

A core that ships a pre-built `workspace/` (`full-stack-app`, `pwa-app`, `landing-page`, `copywriting`, `deepseek-harness`) owns the staleness of its own dependencies the same way it owns everything else about that workspace — this repo has no visibility into any core's dependency tree. Each such core's repo runs its own scheduled dependency-update workflow, shaped to what that workspace actually needs to stay coherent, gated on that workspace's real build/test/lint targets (not a stub), opening a PR for human review rather than merging or publishing on its own:

- `full-stack-app` runs `nx migrate latest` on a schedule, because Nx requires `nx` and every `@nx/*` plugin to be the exact same version — an ordinary per-package dependency bot would land them one PR at a time and break the workspace on every partial state. That gate also regenerates one throwaway domain module through all seven layer generators and typechecks/builds the result, since a migration can silently break generator output in a way that only surfaces the next time a consuming project scaffolds a module.
- `pwa-app` runs the same `nx migrate latest` shape for the same coupled-version reason, gated on `typecheck`/`lint`/`test`/`build` plus a throwaway module scaffolded through all three generators (`feature`, `entity`, `integration`) and rebuilt, since a migration can just as easily break generator output here.
- `landing-page` has no coupled version matrix (Astro, Tailwind, and the rest resolve independently), so its update workflow is an ordinary grouped dependency bump gated on `astro check`, `eslint`, and `astro build`.
- `copywriting` has no coupled version matrix (the `retext` plugins, `write-good`, and `flesch`/`flesch-kincaid` resolve independently), so it's an ordinary Dependabot grouped minor/patch bump against `workspace/scripts/check-copy`'s own `package.json`, gated on that package's real test suite (`npm test`, confirming the gate still discriminates AI-tell text from clean text) on every pull request via `.github/workflows/check.yml` — not merged unattended.
- `deepseek-harness` has no coupled version matrix, so its update workflow is an ordinary grouped dependency bump gated on scaffolding a throwaway plugin through `generate:tool` and running `verify-scaffold.mjs` against it.
- `authored` ships no pre-built workspace — its stack is chosen per-project at design time, not pinned in the package — so it has no workspace dependencies to keep current.
- `adopted` ships no pre-built workspace either — it wraps whatever stack the adopted repo already had — so it too has no workspace dependencies to keep current.

A new core that ships a pre-built workspace should add the equivalent: a scheduled workflow that updates that workspace's dependencies as a single reviewable PR, gated on real targets run against the real workspace, never merging or publishing itself.

## Concurrency: single working tree and worktree branching

Two independent mechanisms make concurrent work safe, at two different granularities.

**Leases and the commit lock — within one working tree.** `hedgehog claim` (`src/db/claim.mjs`) lets several tasks be claimed concurrently, each gated by `conflict.mjs`'s exclusive/scope/verify-radius predicate so two claimed tasks never touch overlapping files. Every claim records a working-tree snapshot (`claim_snapshot`) so `hedgehog verify`'s scope gate can tell which dirty paths are this task's own doing versus a concurrent neighbor's legitimate edits or the user's own half-finished work. But git itself has one working tree and one index no matter how many tasks are claimed, so the git-mutating instant of `verify` — the scope diff, staging, and commit — is serialized through `withCommitLock` (`src/db/commitLock.mjs`, backed by the gitignored `.hedgehog/commit.lock`). This is the whole concurrency model for a project that never declares `intent_dependencies`, and it is unaffected by worktree branching: `withCommitLock`, `claim`/`release`/`renew`, and `verify`'s scope gate behave exactly as they do without the feature below, because `DB_PATH` and `LOCK_PATH` are both relative to `process.cwd()` — a project with no eligible intent never triggers a second working tree, so there is only ever the one lock, the one index, and the one graph these mechanisms were built for.

**Worktree branching — across intents.** An intent whose `intent_dependencies` (`intent_dependencies` table, `schema.mjs`) are all `complete` builds in its own `git worktree`, on its own branch (`hedgehog/<intent-id>`), in a sibling directory outside the repo. `hedgehog plan` is the trigger: run on trunk, it checks every pending intent's dependencies (`src/db/worktree.mjs#eligibleIntents`) and, for each one whose dependencies just cleared, runs `git worktree add -b hedgehog/<intent-id> <path>` and re-invokes `hedgehog plan` inside that new worktree so the intent's tasks compile only there. Two things keep this narrowly scoped:

- **Declaring at least one dependency is part of eligibility, not just "all complete."** An intent with no declared `intent_dependencies` is never vacuously eligible the instant it's proposed — otherwise every intent on a project that has never used `--depends-on` would get worktreed on its very first `hedgehog plan`. This is what keeps the single-working-tree flow above completely unaffected for a project that never declares an intent dependency: `eligibleIntents` never selects anything for it, `hedgehog plan` never creates a worktree, and every task compiles onto trunk exactly as it always has.
- **`once: true` / core-module tasks never move.** They have no real intent to hang a worktree off — `plan.mjs`'s synthesised `_core` intent is explicitly excluded from `eligibleIntents` by id — so cross-cutting infrastructure layers always build on trunk, running after the merges around them.

Each worktree gets its own `.hedgehog/hedgehog.db` — there is no shared database and no cross-DB merge step. This falls out of `DB_PATH` already being relative to `process.cwd()`: a fresh worktree has no database of its own until `ensureDb` (`bin/cli.mjs`) rebuilds one from `.hedgehog/intents/` and git history, the same recovery path a fresh clone goes through. A worktree can only see what its branch has *committed* — `hedgehog intent add` writes a project's `.hedgehog/intents/<id>.json` to disk but does not commit it, so `hedgehog plan` refuses to worktree an intent whose file isn't committed yet (`worktree.mjs#intentFileCommitted`) rather than creating a worktree with nothing to compile.

`hedgehog merge <intent-id>` is the only way an intent's worktree closes successfully. It refuses outright if the intent's tasks are not all `complete` in the worktree's own graph — checked there, not on trunk, since trunk never held a row for a task compiled only inside the worktree. On success it runs `git merge --no-ff hedgehog/<intent-id>`, then `hedgehog db rebuild` on trunk, then removes the worktree and its branch. The design rests on the same fact `hedgehog db rebuild` already relies on for a fresh clone: the build graph is a pure function of committed files and git history. Merging never copies a database row from one graph to another — git merges the sources (the intent file, the built code, any notes/reconciliation records), and the rebuild re-derives trunk's graph from what merged, crediting each task complete the same way `markCompletedTasks` always has: by matching a commit subject in history against the task's `commit_message`.

`hedgehog abandon <intent-id> --reason "<why>"` is the other way a worktree closes — for an intent that will never finish. It writes a committed record (`.hedgehog/abandoned/<intent-id>.json`, temp-file-plus-rename like every other committed record this engine writes), resets the intent's tasks to `planned` on trunk, and removes the worktree and branch. The record is what makes the abandonment survive `hedgehog db rebuild`: without it, a rebuild that recompiles the intent from its still-present intent file would flip the intent back to `active` with no trace of why it had stopped, silently un-abandoning it — the same class of gap the committed-record fix for `debt`/`decisions` notes closed (`src/db/notes.mjs`, replayed by `rebuild.mjs`). Abandonment is never routed through `claim.mjs`'s lease-expiry reaping: a worktree legitimately sits idle for days between sessions, and treating that idleness as a dead lease would garbage-collect real, unfinished work instead of leaving it for a deliberate decision.

`hedgehog status` lists every active worktree and flags an orphaned one — a `hedgehog/*` branch whose worktree directory is gone, or that no longer has an active `git worktree list` entry, with no merged (`intents.status = 'complete'`) or abandoned record to explain why. An orphan needs a decision: finish it (recreate the worktree on the existing branch, then `hedgehog merge`) or `hedgehog abandon` it.

## `full-stack-app` core

Package and source: [`skyf0xx/hedgehog-core-full-stack-app`](https://github.com/skyf0xx/hedgehog-core-full-stack-app).

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

## `pwa-app` core

Package and source: [`skyf0xx/hedgehog-core-pwa-app`](https://github.com/skyf0xx/hedgehog-core-pwa-app).

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | Next.js (App Router, static export) | Same framework family as `full-stack-app`'s web app; no server runtime needed. |
| Build/graph | Nx | Boundary enforcement and generators, single-app layout (no `apps/`, no `libs/`). |
| Package manager | pnpm | Matches every other core. |
| Local DB | Dexie 4 | The one supported IndexedDB abstraction; raw IndexedDB/`localStorage` are lint-forbidden. |
| Sync + auth | `dexie-cloud-addon` (optional, off by default) | Two-way sync, passwordless OTP/OAuth, and server-enforced realm access control on the same Dexie instance. |
| Remote entities (optional, off by default) | Supabase (Postgres + RLS + Auth + Edge Functions) | The one supported backing store for an entity declared `--remote`, addressed through the same repository interface as Dexie. |
| Validation | Zod | Entities, imports, and external responses; types are inferred, never hand-maintained. |
| Remote state | TanStack Query | External API responses only — never a substitute for the local DB. |
| Styling | Tailwind v4 + hand-built ShadCN base | Same base as `full-stack-app`'s `apps/web`. |
| PWA | `@serwist/next` | Manifest, service worker, precached app shell, offline fallback. |
| IDs | Dexie's sharded auto-generated string keys | Collision-free across devices, and the form Dexie Cloud requires. |
| Testing | Vitest + `fake-indexeddb` + Testing Library | Repository tests run against a real IndexedDB implementation in-process. |
| E2E | Playwright | Offline-mode and install-manifest checks. |
| Linting | ESLint + Prettier + `@nx/enforce-module-boundaries` | Architecture rules are lint rules. |
| Commits | Conventional Commits | Enforced by `commitlint` + `lefthook`, same as every core. |

Five layers, module-axis, no server tier: `schema → repository → hook →
screen → join`. The app owns its state locally through a repository
boundary above Dexie; sync (Dexie Cloud) and remote-backed entities
(Supabase, per-entity via `--remote`) are both opt-in and sit behind the
same repository interface, so a hook or screen can't tell which backs
it. A project whose server-side logic spans most of the app — not one or
two server-authoritative entities — belongs on `full-stack-app` instead;
see that core's `selects_when` in `src/registry/cores.json`.

## `landing-page` core

Package and source: [`skyf0xx/hedgehog-core-landing-page`](https://github.com/skyf0xx/hedgehog-core-landing-page).

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

## `copywriting` core

Package and source: [`skyf0xx/hedgehog-core-copywriting`](https://github.com/skyf0xx/hedgehog-core-copywriting).

For drafting and iterating copy — marketing copy, product UI strings,
docs prose — against a mechanical gate instead of an agent's own
self-review.

| Layer | Choice | Why |
| --- | --- | --- |
| Grammar/pattern checks | `retext` + `retext-passive`, `retext-intensify`, `retext-repeated-words`, `retext-readability` | Sentence tokenization and grammatical-pattern detection (passive voice, weasel words, repeated words) are known to be error-prone to reimplement from scratch; this is the same class of tool `proselint` and Vale use. |
| Wordy-phrase/cliché checks | `write-good` | Direct dependency for the phrase-level heuristics `retext`'s pattern-based plugins don't cover. |
| Readability scoring | `flesch` + `flesch-kincaid` | Real document-level Flesch Reading Ease and Flesch-Kincaid Grade formulas, computed from actual sentence/word/syllable counts, not a per-sentence proxy. |
| Output contract | `zod` | Validates the structured violation report every rule reports through — the shape the loop skill parses as a real pass/fail gate. |
| AI-tell vocabulary/phrasing | Custom regex (`scripts/check-copy/rules/tells.mjs`) | No library covers GPT-specific tells (banned vocabulary, negation formulas, hedge stacks, em-dash/rule-of-three density); sourced from Wikipedia's "Signs of AI writing" essay and cross-checked against `landing-page`'s own prose rules. |

Two layers, no module axis: `brief` (planning intake mined into a
what/audience/register statement) → `draft` (the loop skill drafts,
runs `node scripts/check-copy/index.mjs`, revises against its JSON
report, capped at 6 iterations). A pass is a script exit code, not a
sentence — the same trust model `hedgehog verify` applies to every
other core's build layers, extended to prose quality specifically.
Standalone from every other core for now; not wired into
`landing-page`'s own copy skill, which keeps its existing prose
self-check until this core's rule set has been exercised on more real
drafts.

## `deepseek-harness` core

Package and source: [`skyf0xx/hedgehog-core-deepseek-harness`](https://github.com/skyf0xx/hedgehog-core-deepseek-harness).

For building a plugin, tool, hook, or extension for DeepSeek Harness
(DSH), a Cordis-based agent framework — not for building an application.

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | `@deepseek-ai/dsh` + `@deepseek-ai/cordis` | The framework a plugin actually loads into; nothing to substitute. |
| Tooling | `@deepseek-ai/dsh-tools` | The one supported way to define and register a tool DSH agents can call. |
| Package manager | pnpm | Matches every other core. |
| Scaffold generator | `workspace/tools/generators/` (`generate:tool`) | One plugin's boilerplate per intent, not hand-authored per plugin. |

Six layers, one plugin per intent: `scaffold → logic → wiring → smoke →
bundle → join`. A `cordis.patch.yml` manifest and `ctx.tools.register`
calls are the concrete signals `planner` reads to route here instead of
`authored`; see this core's `selects_when` in `src/registry/cores.json`.

## `authored` core

Package and source: [`skyf0xx/hedgehog-core-authored`](https://github.com/skyf0xx/hedgehog-core-authored).

**From-scratch design** (`hedgehog-core-design`): unlike other cores, this one picks
the stack and derives the layer sequence per project, then generates and
verifies the workspace live.

## `adopted` core

Package and source: [`skyf0xx/hedgehog-core-adopted`](https://github.com/skyf0xx/hedgehog-core-adopted).

**Brownfield adoption** (`hedgehog-adopt`):
brings Hedgehog's discipline to a repo that already exists without
bootstrapping a workspace, installing agents/skills and the build graph
alongside the existing code structure. Carries its own copy of
`hedgehog-authored-loop` and `layer-eng`, tuned for adoption's per-change
Stop Condition and linear-chain-only shape — a separate package from
`authored` rather than a second mode of it, since the two diverge in
intake, lock artifact, and Stop Condition semantics and share only that
build loop.

## The `core.yaml` contract

This section is the named owner of what every field in `.hedgehog/core.yaml`
means — the contract between the parser (`src/db/core.mjs`, plus every
consumer that reads a compiled task's layer-derived fields) and the prose
that reads the same file (`hedgehog-daily`, `tweaker`, `reviewer`, and the
two writers, `hedgehog-core-design` in the `authored` core and
`hedgehog-adopt` in the `adopted` core). A change to any field's meaning,
default, or allowed values updates this table in the same commit.

Two fields are named loosely elsewhere and are clarified here once: a
layer's identifier field is `id`, never `name` — the parser has no `name`
key at any level. Cardinality (one task per intent vs. one task for the
whole build) is expressed by the boolean `once`, not by a field called
`per` — the parser has no `per` key either.

### Top-level fields

| field | source path | reader | default / absent behavior | allowed values | positive / negative example | skill reading | fallback | writer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `id` | `src/db/core.mjs:224` (parse), `:654` (validate) | `parseCoreYaml`, `validateCore` | **Required.** Absent throws `core definition missing top-level id`. | any non-empty scalar | positive: `id: full-stack-app`. negative: file with no `id:` line throws at `validateCore`. | Not read by name by any skill/agent prose — code-only. | n/a (required) | Both writers emit it as the first line (`hedgehog-core-design` Step 5 example; `hedgehog-adopt` Step 5, "exact format `src/db/core.mjs` parses"). |
| `pluralizes` | `src/db/core.mjs:233` (parse) | `parseCoreYaml`; consumed by `bin/cli.mjs:1650`/`:1679` (`intent add`'s singular-id advisory) | Optional. Absent → `true`. | `true` / `false` | positive: `pluralizes: false` (deepseek-harness — its tool generator uses the module id verbatim). negative: omitted on every core predating the field; reads as `true`, matching prior behavior. | Not mentioned in `hedgehog-daily`, `tweaker`, or `reviewer` — code-only (`bin/cli.mjs`, out of scope for this audit to edit). Neither writer skill emits it; both leave it at the default. | n/a — absence is itself the documented default, not a gap. | Neither writer names it explicitly; correct by the default (both writers' example cores have generators that pluralize normally). |
| `pattern` | `src/db/core.mjs:187,240-248` (parse), `:630-647` (dispatch), `checkLayeredPattern`/`checkHexagonalPattern` | `parseCoreYaml`, `checkPatternConformance` | Optional. Absent → `null`, and `checkPatternConformance` skips all checking — identical to a core written before the field existed. | `hexagonal`, `layered`, `vertical-slice`, `none` — a typo throws at **parse** time (`VALID_PATTERNS`), not load-silently-as-unset. | positive: `pattern: vertical-slice` on a core where some layer's scope contains `{module}`. negative: `pattern: hexagonal` on a core whose head layer has a `depends_on` throws (`core.mjs:592`). | Not mentioned in `hedgehog-daily`, `tweaker`, or `reviewer` — none of the three shared consumer skills read or act on `pattern`. Code- and writer-only. | n/a — no shared skill depends on it. | Both writers: `hedgehog-core-design` Step 3/4/5 (derives from the blueprint, re-derives after adaptation, module axis forces `vertical-slice`) and `hedgehog-adopt` Step 1/3 (observes from workspace-manifest evidence only, `none` unless unambiguous, chain wins over declaration on conflict). |

### Per-layer fields

| field | source path | reader | default / absent behavior | allowed values | positive / negative example | skill reading | fallback | writer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `id` (layer) | `src/db/core.mjs:272` | `parseCoreYaml`, `validateCore:660` | **Required.** Absent throws `layer missing id`. | any non-empty scalar, unique within the core | positive: `id: schema`. negative: a layer with no `id:` line throws. | `hedgehog-daily` SKILL.md:26 ("each layer's `id`, `scope` globs, `verify` command…") — matches code exactly. | n/a (required) | Both writers emit it per layer. |
| `depends_on` | `src/db/core.mjs:273-274` | `parseCoreYaml`; `validateCore:717-724` (must resolve); `plan.mjs` (edge compilation); `checkLayeredPattern`/`checkHexagonalPattern` | Optional. Absent → `null` (no parent — legal only for the head layer, or any layer under `pattern: none`/unset). | must name another layer in the same core, or absent | positive: `depends_on: scaffold`. negative: `depends_on: nonexistent` throws `core.mjs:721`. | Not named directly in `hedgehog-daily`/`tweaker`/`reviewer` prose (they reason about "layers" and "the chain" without citing the field). | n/a | Both writers state it explicitly: `hedgehog-core-design` Step 5 ("`depends_on` is omitted only on the first layer"), `hedgehog-adopt` Step 3 (chain via `depends_on`). |
| `scope` | `src/db/core.mjs:275` | `parseCoreYaml`; `validateCore:661-663` (required, non-empty); `plan.mjs#layerTaskFields`/`onceLayerTaskFields` (compiles to `scope_globs`); `conflict.mjs#scope` (scheduler); `verify.mjs` (pre-verification scope gate) | **Required, non-empty.** Absent or `[]` throws `layer "<id>" missing scope`. | inline list of git-pathspec `:(glob)` globs (`*`/`?` stay in one segment, `**` spans segments) | positive: `scope: ["apps/api/src/{module}/**"]`. negative: `scope: []` throws. | `hedgehog-daily` SKILL.md:25-27,63-65 ("Every file it touches is inside one layer's `scope` globs") and "Never widen a layer's `scope`" (:118) — matches: scope is the hard write boundary in both code and prose. `tweaker.md` does not cite it directly; it defers to `hedgehog-daily`. | Treated as always-present by every skill (correctly — the field is non-optional by `validateCore`). | Both writers: `hedgehog-core-design` Step 5 ("`scope` must be an inline list") and the module-axis `{module}` requirement (Step 4); `hedgehog-adopt` Step 3 (`["**"]` for the no-seam / tail-join case). |
| `verify` | `src/db/core.mjs:276` | `parseCoreYaml`; `validateCore:664-666` (required); `plan.mjs` (compiles to `verify_command`); `verify.mjs` (the command actually run); `requires.mjs` (binaries it needs) | **Required, non-empty.** Absent throws `layer "<id>" missing verify`. | any shell command scalar (quoted scalars unescaped per YAML rules — see `core.mjs`'s header) | positive: `verify: "pnpm test {module}"`. negative: layer with no `verify:` line throws. | `hedgehog-daily` SKILL.md:25-27,71-72 ("Run that layer's own `verify` command from `core.yaml`") and Hard rules :120 ("Never commit a tweak whose layer `verify` command fails") — matches exactly. `tweaker.md`:227 same. | n/a (required) | Both writers: extensive rules in `hedgehog-core-design` Step 5 (must prove the layer's claim, must run the framework's real build, filter-token cross-check against `scope`); `hedgehog-adopt` Step 2 (only the repo's own confirmed commands, never invented). |
| `commit` | `src/db/core.mjs:277` | `parseCoreYaml` (no `validateCore` check) | Optional by the parser (absent → `''`), but `plan.mjs`'s comment and `hedgehog-core-design` Step 5 both flag it as **required in practice** — an empty `commit_message` breaks the Correction Protocol and `hedgehog why`. | any scalar, conventionally a Conventional Commits subject with a `{module}` token on a module-axis core | positive: `commit: "feat({module}): schema"`. negative: omitted — loads fine, but compiles a task with `commit_message: ""`, which `validateCore` does **not** reject (a documented gap, not a bug — see Finding below). | Neither `hedgehog-daily` nor `tweaker` nor `reviewer` reads `commit` directly — `tweaker`/`hedgehog-daily` cite the *conventional-commits skill's* format for what they write, not this field. | No skill states a fallback for an absent `commit` — see Finding: silent-empty is possible and undocumented in the shared skills (only `hedgehog-core-design` Step 5 flags it). | Both writers set it on every layer; `hedgehog-core-design` Step 5 explicitly calls out that `validateCore` will not catch its absence. |
| `exclusive` | `src/db/core.mjs:279-280` | `parseCoreYaml`; `conflict.mjs#conflicts:51` (scheduler: either side exclusive → never co-scheduled); `validateCore:776-785` (module-axis layers exempt from `{module}`-in-scope requirement when `exclusive: true`) | Optional. Absent → `false` (concurrency-safe by default). | `true` / `false` | positive: `exclusive: true` on a `join` layer. negative: n/a — no invalid value throws; a non-`"true"` string parses to `false` silently (see Finding). | `hedgehog-daily` SKILL.md:96-101 ("A layer with a wider `verify_radius`, or `exclusive: true`: the same real test bar and `reviewer` pass") — matches conflict.mjs's isolation-flag meaning. `reviewer.md:22-23` ("the layer is `exclusive: true` — a join or integration point") — matches. | Both skills correctly treat absent `exclusive` as "not a join point" / "ordinary concurrency" — no field-assumed-present issue found here. | `hedgehog-adopt` Step 3 mandates it on the tail join layer explicitly; `hedgehog-core-design` Step 4 discusses it alongside `once` for shared infra. |
| `once` | `src/db/core.mjs:284` | `parseCoreYaml`; `plan.mjs` (`compileOnceTasks`, cardinality); `validateCore:739-761` (no `{module}` allowed, not all layers may be `once`) | Optional. Absent → `false` (per-intent, the default cardinality). | `true` / `false` | positive: `once: true` on a cluster-provisioning layer. negative: `once: true` layer whose scope contains `{module}` throws `core.mjs:748`. | Not named in `hedgehog-daily`/`tweaker`/`reviewer` — none of the three shared skills reason about cardinality; only the writers and `plan.mjs`/`drift.mjs` do. | n/a — no shared skill depends on it. | `hedgehog-core-design` Step 4 (extensive: when to use it, the two rules it forces, re-entrancy design); `hedgehog-adopt` never emits it — the adopted core is always linear/per-change, so `once` never applies there (confirmed: not mentioned in `hedgehog-adopt`'s SKILL.md). |
| `verify_radius` | `src/db/core.mjs:286-289` (parse), `:676-692` (validate coverage), `conflict.mjs#verifyRadius:41-44` | `parseCoreYaml`; `validateCore` (must cover own `scope` when declared); `conflict.mjs#verifyRadius` (scheduler); `lintCore` (coverage/anchoring heuristics) | **Sentinel: `null` (not `undefined`, not `[]`) means "fall back to `scope`"** — `conflict.mjs:41-44`: `if (task.verify_radius == null) return scope(task)`. An **empty list is rejected outright** (`core.mjs:677-681`, distinct from the `requires` sentinel below). | inline list of globs, or omitted (→ `null`) | positive: `verify_radius: ["packages/db/**"]` on a schema layer whose verify typechecks the whole package. negative: `verify_radius: []` throws `core.mjs:678` ("declares an empty verify_radius — omit the field to fall back to scope"). | `hedgehog-daily` SKILL.md:26-27,94-96 ("A layer whose `verify_radius` equals its `scope`: run the layer's `verify` command… A layer with a wider `verify_radius`…") — this is the field the issue flagged as the one prose is most likely to get subtly wrong. The skill's wording treats "equals scope" and "wider" as the two cases, which matches `conflict.mjs`'s fallback, but never states the `null` sentinel by name or that an *absent* field is what triggers the equals-scope case — a reader who doesn't already know the sentinel could reasonably ask "what if it's declared as `[]` or partially narrower?" and get no answer from this skill alone. `reviewer.md:21-23` has the same gap: "a layer's `verify_radius` is wider than its own `scope`" without stating what "wider" is computed against when the field is absent. | Neither skill states the fallback explicitly (they describe the *consequence* of the fallback — "equals scope" — without naming the sentinel that produces it). This is a borderline finding: functionally correct, but a reader auditing `core.yaml` by hand from the skill text alone, with no access to `conflict.mjs`, cannot derive that "absent" and "declared equal to scope" produce identical scheduler behavior with certainty. | `hedgehog-core-design` Step 4b/Step 5 states the sentinel precisely: "leave `verify_radius` undeclared — it defaults to `scope` when unset (`conflict.mjs`'s `verifyRadius()`)." `hedgehog-adopt` never emits a non-default radius (its layers are scope-radius-equal by construction). |
| `requires` | `src/db/core.mjs:294-295` (parse), `:698-707` (validate), `requires.mjs` (resolution) | `parseCoreYaml`; `validateCore` (must be a list of non-empty strings when present); `requires.mjs#coreMissingRequirements` (`hedgehog status`), `verify.mjs` (`hedgehog verify` refuses to run if unresolved) | **Sentinel: `[]` (not `null`) means "no binaries" — same as absent.** `core.mjs:290-295`: absent → `[]` directly (no separate null state, unlike `verify_radius`). | inline list of non-empty binary-name strings, or omitted (→ `[]`) | positive: `requires: ["terraform", "kubectl"]`. negative: `requires: [""]` throws `core.mjs:704` ("empty entry in requires"). | Not mentioned in `hedgehog-daily`, `tweaker`, or `reviewer` — none of the three shared skills read or route on `requires`. `hedgehog status`'s own output (`requires.mjs#formatMissingRequirements`) is the only place a missing binary surfaces, and that's code output, not skill prose. | n/a — no shared skill depends on it, so there is no risk of a skill assuming it present. | `hedgehog-core-design` Step 5's last bullet: "Declare the binaries `verify` needs, in `requires`… only for tools that come from outside the workspace." `hedgehog-adopt` never emits it (not mentioned in its SKILL.md — every `verify` command it proposes is already an existing repo script, so an external-binary declaration was never designed into that skill). |

### Findings — code/prose disagreements and gaps

1. **The issue's own field list names fields the parser doesn't have.** Issue
   #343's "What to check" §1 lists per-layer fields as `name`, `scope`,
   `verify`, `exclusive`, `per`, `verify_radius`, `requires`. The parser has
   no `name` key (the field is `id`) and no `per` key at any level
   (cardinality is the boolean `once`). Read literally, an implementer
   grepping `core.yaml` for `name:` or `per:` would find nothing. Recorded
   here rather than filed as a bug against the issue itself — the intent
   ("per-layer identity and cardinality") was clear from context.
2. **`verify_radius`'s `null`-means-scope sentinel is never named by field or
   value in `hedgehog-daily` or `reviewer`.** Both skills correctly describe
   the *behavior* the sentinel produces ("radius equals scope" / "radius is
   wider than scope") but neither states that omitting the field is what
   causes the "equals scope" case, nor that a declared-but-empty list is
   rejected rather than silently treated the same as absent. Someone editing
   `core.yaml` from the skill prose alone, without reading `core.mjs`, could
   plausibly write `verify_radius: []` expecting it to mean "no radius" —
   the parser rejects that at `validateCore` with a clear message, so the
   failure is loud, not silent, but the skill text doesn't warn against it
   ahead of time. This is a prose-completeness gap, not a behavior bug —
   flagged for #342 (skill content), not fixed here per this issue's own
   "falling out of the table" scope split.
3. **`commit`'s "required in practice" status is undocumented outside
   `hedgehog-core-design`.** `validateCore` never checks `commit` is
   non-empty; only `hedgehog-core-design` Step 5 and a code comment in
   `plan.mjs` state that an empty commit message breaks the Correction
   Protocol and `hedgehog why`. `hedgehog-adopt` does not carry the same
   explicit warning (though its own worked examples always populate the
   field). Flagged for #342 — a prose fix, not a schema change.
4. **`exclusive`'s non-`"true"` values parse to `false` with no validation.**
   `core.mjs:280` is `parseScalar(value) === 'true'` — there is no rejection
   of `exclusive: yes` or `exclusive: True` the way `pattern` rejects an
   unrecognized value at parse time. A typo silently produces "not
   exclusive" rather than a load error. This is closer to a schema
   observation than a prose one; noted here as a finding but left
   unfixed — see "Out of scope" below.

None of these four rise to a behavior bug that ships broken output: the
worst case in each is a message that assumes background knowledge, not a
check that passes when it should fail. No new GitHub issue was filed for
any of them; #342 (skill-content audit) is where 2 and 3 belong, and 4 is
noted for a future schema-hardening pass rather than filed, since this
issue's scope is conformance auditing, not schema changes.
