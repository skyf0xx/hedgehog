---
name: hedgehog-loop
description: Use for every unit of work once a Hedgehog project is bootstrapped — building one layer (schema, contract, repository, service, controller, hook, screen) per module, gated by `hedgehog verify` and committed one layer at a time. Triggers on "next step", "build this module", "what's next", or the start of any work session on a bootstrapped project. Also covers the Correction Protocol for fixing a wrong upstream step.
---

# Hedgehog Loop

The operating loop for a bootstrapped Hedgehog project: `hedgehog claim`
reserves the packet(s) for ready layers, build them, `hedgehog verify`
gates and commits each. The build graph (`.hedgehog/hedgehog.db`) is the
live list — query it via `hedgehog status`/`hedgehog ready`, never
re-derive state from prose. The step tables below mirror
`src/golden-cores/full-stack-app/core.yaml`, the design source of truth
for layer order, scope, and verify command per layer — read the tables
for the human-readable shape, and the YAML when they seem to disagree.

The packet, though, is what actually runs. `hedgehog plan` copies each
layer's scope globs, verify command and commit message onto every task
row at compile time; from then on the row — not `core.yaml` — is what
`hedgehog claim` hands out and `hedgehog verify` gates against, and
editing `core.yaml` afterwards does not reach tasks already compiled (a
plain `hedgehog plan` re-run won't apply it either — it only reads
intents still pending). `hedgehog status` prints a **DRIFT** section
whenever the two have diverged, and `hedgehog plan --recompile` rewrites
the layer-derived fields on not-yet-started tasks from the current
`core.yaml`, refusing — and naming — every task already building,
verifying, complete, or blocked. Never patch a task row in SQLite by
hand: the DB is derived and gitignored, so `hedgehog db rebuild` drops
the patch.

## Determine phase

Before touching code, know which phase applies to the module in scope:

- **Phase A** — building/extending the backend. Every module in scope
  needs schema → contract → repository → service → controller before
  Phase B starts for any of them.
- **Phase B** — Phase A is closed for the module. Build hooks and screens.

Check `hedgehog status` (or `hedgehog why <path>` for a specific file),
or the commit log for `feat(<module>): api` commits. No such commit (and
no `controller` task `complete` for that module) means the module is in
Phase A.

## The Domain Module Pattern

A **domain module = one table.** `users`, `orders`, `order_items` are each
their own module, carrying the full step sequence below. The schema is the
source of truth for module boundaries.

**Cross-module references are FK-by-ID only.** If `orders.user_id`
references `users`, the `orders` schema holds a plain FK column. The
`orders` repository and service depend only on their own ports — a service
knows related entities only as an ID.

- Need the related row? Resolve it at the contract/controller layer
  (parallel calls to each module's own endpoint), or join against the
  other module's *schema* directly inside the repository (Drizzle query).
- This keeps every service importing only its own module's port, which is
  what `eslint-base.js`'s `no-restricted-imports` rule for
  `libs/*/service/**` enforces (wired at bootstrap) — a service reaching
  a `*.adapter`, `drizzle-orm`, or `packages/db` fails lint.

A junction table (e.g. `order_items`) is one table, one module, with two
FK-by-ID columns instead of one, each resolved the same way.

Every module goes through the same shape, in order:

```
schema      (Drizzle)              — types before data
contract    (Zod / ts-rest)        — the boundary
repository  (port + Drizzle adapter)
service     (domain logic)         — imports only ports
controller  (thin HTTP)
hook        (TanStack Query)       — Phase B only
```

Plus, when an operation needs async **and the Queue add-on is on for this
project** (check `.hedgehog/addons.yaml`'s `queue.on`): **queue = port +
BullMQ adapter**, same port/adapter shape as the repository. The service
imports only ports. Queue is one-time project infra, not a compiled
layer — `full-stack-app/core.yaml` has no `queue` layer, so this step has
no `hedgehog verify` gate of its own; build it as part of the
`controller` layer's packet, verified by that layer's own check. If the
Queue add-on is off, there's no `apps/worker` and no queue step, full
stop — an operation that seems to want async processing on a Queue-off
project is a signal to revisit that add-on decision with `planner`, not
to build a one-off queue outside the add-on's scaffolding.

Every layer scaffolds from its own generator in `tools/generators/` (see
"Scaffolding a layer" below) — package shell, tags, files, barrel wiring,
and the layer's conventional shape all land in one deterministic step.
What's authored on top is the entity-specific delta: the field list and
its types, the module's business rules, and the UX intent behind its
screen.

## Domain Module — Backend Steps (Phase A, every module in scope)

A horizontal pass across the whole backend — every module goes through
these before any module gets a hook or screen. Each row is one compiled
layer in `full-stack-app/core.yaml`; delegate each module's Phase A
layers to the `backend-eng` agent, one claimed packet per dispatch — it
builds the layer, `hedgehog verify` gates and commits it.

| # | Layer | Lives in | Commit |
|---|---|---|---|
| 1 | `schema` | `packages/db` (Drizzle) | `feat(<module>): schema` |
| 2 | `contract` | `packages/contracts` (Zod via `drizzle-zod` + ts-rest) | `feat(<module>): contract` |
| 3 | `repository` | `libs/<module>/repository` (port + Drizzle adapter) | `feat(<module>): repository` |
| 4 | `service` | `libs/<module>/service` (domain logic — imports only ports) | `feat(<module>): service` |
| 5 | `controller` | `apps/api` (thin HTTP, wires contract → service; bundles Queue infra, see above, if that add-on is on and this module needs it) | `feat(<module>): api` |

Repeat 1–5 per module in scope, via `hedgehog claim`/`hedgehog verify`.
The API is complete, typed, and callable (Postman/curl/contract tests)
before frontend work starts.

## Domain Module — Frontend Steps (Phase B, after Phase A closes for the module)

| # | Layer | Lives in | Commit |
|---|---|---|---|
| 6 | `hook` | `packages/hooks` (TanStack Query) | `feat(<module>): hooks` |
| 6a | UX rationale | `docs/design/<module>.md`, `ux-planner` agent | bundled into layer 7's commit |
| 7 | `screen` | `apps/web`, plus `apps/mobile` when the Mobile add-on is on | `feat(<module>): screen-web` |

Phase B starts once Phase A is done for the scope. The frontend is a pure
consumer of an already-finished API. Delegate each module's Phase B
layers to the `front-end-eng` agent, same reasoning as `backend-eng` for
Phase A — one claimed packet per dispatch, in its own context. Step
6a is where "how it should feel" gets decided — once per module, after
the `hook` layer's task is `complete` and before `front-end-eng` starts
the `screen` layer — via `ux-planner`, starting from whatever `planner`
filed in `docs/design/<module>-notes.md` at planning intake, or the raw
UX spec directly if that file is absent. Its first run for a module also
signals to the user that Phase B has started, and is the point a mockup,
screenshot, or export (Google Stitch, Figma) can be handed over. It
writes `docs/design/<module>.md`, not its own compiled layer — the
`screen` layer's `hedgehog verify` is what gates and commits it.

## The Loop (every unit of work)

1. **Run `hedgehog claim --count N --owner <owner>`.** `<owner>` is this
   session (a stable id — session id or equivalent). Claim is atomic and
   lease-based, safe for concurrent claimers, and is the entry point into
   the loop — `hedgehog next` still exists as a read-only preview of the
   single next task, but claim is what actually reserves work. `--count
   N` is a maximum, not a promise: it returns however many tasks are
   safe to run together right now (the conflict predicate already
   filtered them against each other), which may be fewer than N, or
   zero. `hedgehog ready` previews the same decision without claiming
   anything — CLAIMABLE vs HELD BACK, with the reason for each holdback —
   useful for understanding the scheduler before committing to a claim.
2. **Dispatch each claimed packet to its own subagent** — `backend-eng`
   (Phase A) or `front-end-eng` (Phase B), matching each packet's ALLOWED
   SCOPE — in ONE message with parallel tool calls, not one agent call
   after another. This is a Claude session orchestrating via the Agent
   tool's parallel-call mechanism: N claimed tasks means N Agent calls in
   the same message.
3. Each agent **runs typecheck/lint/test on its own work** (mirrors
   lefthook, wired at bootstrap) as a sanity check before reporting
   back — necessary, not sufficient. Per task, per agent: the agent
   reports its work as done; it does not move the task and does not
   commit.
4. **As each report arrives, verify it — one at a time, serially.** Run
   `hedgehog verify <task-id> --owner <owner>` (the same owner that
   claimed it; verify requires the lease owner). Building happens in
   parallel; verifying does not — verify writes a commit, and commits go
   through one at a time. It checks the touched files against the
   packet's ALLOWED SCOPE, runs the layer's VERIFICATION command, and on
   a pass writes the commit (the exact Conventional Commit message from
   the tables above, plus the updated build graph) and unlocks the next
   layer. On a scope violation or a failing check, the task moves to
   `blocked` with a `blocked_reason` of `scope_violation` or
   `verification_failed`, and nothing downstream unlocks. Fix the work,
   then run `hedgehog retry <task-id>` to return the task to `planned`,
   claim it again (by task id — see below), and verify again —
   `hedgehog verify` only accepts a task you currently hold in
   `building`, so a blocked task has to go back through `retry` and
   `claim` first. Don't hand-commit around it.

   A `blocked` task anywhere in the graph — in this module or any other —
   makes `hedgehog claim --count N` refuse to hand out anything at all,
   with a non-zero exit naming the blocked task(s). `hedgehog status`
   lists them too, under NEEDS ATTENTION. Fix and `retry` the named
   task(s) before claiming more. A **targeted** `hedgehog claim <task-id>
   --owner <owner>` is exempt — that's how the just-retried task gets
   reclaimed in the step above. A lease the same `claim` call reaps for
   having just expired is exempt too: that call still claims whatever
   else is ready, and the reaped task lands in NEEDS ATTENTION for the
   next `claim` call to stop on.
5. **Repeat** — `hedgehog claim --count N --owner <owner>` again for the
   next batch.

Each claimed packet is the full packet — STATUS/INTENT/RELEVANT
RULES/INHERITED DEBT/WHY NOW/BLOCKED DOWNSTREAM/ALLOWED
SCOPE/VERIFICATION — and its **INTENT** block carries the goal and
outcome of the whole intent, not just this layer's objective. A layer's
verify command runs the tests that layer wrote, so it measures internal
consistency, never coverage of what was asked; build the layer's share of
the goal and say so when the packet doesn't account for something the
goal asks for. When `hedgehog verify` closes the **last** layer of an
intent it prints the goal and outcome back as an **INTENT CHECK** — read
the built work against it there, because nothing else in the build does.

A layer that hits a limitation the next layer must compensate for
declares it with `hedgehog debt add <task-id> "<note>"`; the note lands
in the **INHERITED DEBT** section of every packet that depends on that
task. A comment in a source file is not a mechanism — nothing reads it.

Each `hedgehog verify` call commits exactly one layer, built right for
what's known now; a wrong layer is fixed forward later via the
Correction Protocol. Valid task statuses are `planned`, `ready`,
`building`, `verifying`, `complete`, and `blocked`; a task in `blocked`
also carries a `blocked_reason` (`scope_violation`, `verification_failed`,
or `lease_expired`).

## Scaffolding a layer

`tools/generators/` holds one Nx generator per layer, and every layer
starts from its own:

```bash
nx g ./tools/generators:schema     --module=<module> --fields='<name:type,...>'
nx g ./tools/generators:contract   --module=<module> --fields='<name:type,...>'
nx g ./tools/generators:repository --module=<module>
nx g ./tools/generators:service    --module=<module>
nx g ./tools/generators:controller --module=<module> --fields='<name:type,...>'
nx g ./tools/generators:hook       --module=<module> [--toggleField=<boolField>]
nx g ./tools/generators:screen     --module=<module>
```

`--module` is the domain module's plural kebab-case name (`tasks`,
`order-items`). `--fields` is a comma-separated list of `name:type` pairs
over `string`, `text`, `boolean`, `integer`, and `timestamp`, with a
trailing `?` marking the column nullable
(`--fields='title:string,done:boolean,dueDate:timestamp?'`); `contract`
and `controller` take the same list the module's `schema` was generated
with. `hook`'s optional `--toggleField` names a boolean field from the
schema to expose as a dedicated toggle mutation.

Each generator lands the whole conventional shape of its layer in one
deterministic step — the package shell (`package.json`, `tsconfig*.json`,
`vitest.config.mts`, `src/index.ts`) where the layer creates one, the
`nx.tags` pair `packages/config/eslint-base.js`'s `depConstraints` keys
on, the port-discipline file suffixes lint checks for, the Nest module
and controller pair with `@Controller()` left bare (the ts-rest contract
already encodes full route paths), and every barrel export the new files
need. Hand-copying a sibling module's files invites exactly the drift
`hedgehog verify`'s lint step then has to catch: missing tags, missing
project references, a doubled route prefix.

What the generator lands is the layer's skeleton, not the layer. Author
the entity-specific delta on top: the module's business rules in
`service`, its domain-error mapping in `controller`, and — for `screen`,
which is skeleton-only by design — the layout, information hierarchy, and
interaction pattern from `ux-planner`'s rationale, over the placeholders
the generator leaves for the list, filter shell, empty state, and form.

Registration inside `apps/api` is automatic and stays that way:
`apps/api/src/app/feature-modules.ts` globs
`apps/api/src/app/*/*.module.ts` and is regenerated by the
`generate-feature-modules` Nx target that `build`/`typecheck`/`test`
depend on. Never register a module by editing `app.module.ts` — a shared
file no module-scoped task can safely touch. Validation is ts-rest + Zod,
so this core has no Nest DTOs and no class-validator.

**Wire a new package in before reporting the layer done.** A package that
exists on disk isn't yet part of the workspace:

```bash
pnpm install          # link the new workspace:* deps
pnpm nx sync          # regenerate TypeScript project references
```

`pnpm-workspace.yaml` already globs `packages/*`, `apps/*` and `libs/*/*`,
so a package under any of those needs no edit there. `nx sync` writes root
`tsconfig.json`, which sits outside every module-scoped layer's scope — it
belongs to no layer, and no override covers it. Commit it separately as
`chore(workspace): sync project references`, before `hedgehog verify`
runs, so the layer's own commit stays exactly the layer.

This is the building agent's step rather than a verify post-step on
purpose: `hedgehog verify` gates the tree it's handed, and a gate that
mutates that tree would manufacture the scope violation it then reports.

## First arrival in a package

Every layer scope names a directory *inside* a package
(`packages/contracts/src/{module}/**`, `libs/{module}/repository/**`), and
on the first module through that layer the package itself doesn't exist
yet. Its shell — `package.json`, `tsconfig*.json`, `vitest.config.mts`,
`src/index.ts` — necessarily lands outside the layer's scope glob, because
no `{module}`-bearing glob can cover a package root. Left alone those files
sit on disk uncommitted until the `join` layer's `**` scope sweeps them in,
so `git log -- packages/contracts/` shows source with no buildable package
behind it for the whole middle of the build.

Widen that one task, before building it:

```bash
hedgehog override add TASKS-CONTRACT \
  --scope 'packages/contracts/*' \
  --scope 'packages/contracts/src/index.ts' \
  --reason 'first module through the contract layer also creates the package shell'
```

`.hedgehog/overrides/*.json` is additive, per-task, committed, and replayed
by `plan`, `--recompile` and `db rebuild` alike, so the exception survives a
rebuild and stays reviewable in the diff — unlike a hand-edited task row,
which the next rebuild silently drops. It widens exactly the one task that
creates the package, not the layer, so module two's task keeps the narrow
scope.

Which tasks need it: the first module through `contract`
(`packages/contracts`) and through `hook` (`packages/hooks`), and every
module's `repository` and `service`, since `libs/{module}/repository` and
`libs/{module}/service` are new libs per module — there, the layer's own
`libs/{module}/repository/**` glob already covers the package root, so no
override is needed. `packages/db` and `packages/config` ship with core, so
`schema` never needs one. `controller` never needs one either — `apps/api`
ships with core, and its `apps/api/src/app/{module}/**` scope already
covers the module's generated directory.

Never widen a scope to route around a violation the Correction Protocol
should handle — this is for a package shell the layer genuinely creates,
nothing else. The shell itself comes from the layer's generator
("Scaffolding a layer" above), which is also where the workspace wiring a
new package needs lives.

## Intra-step conventions

The Nx boundaries, phase gate, and lint own the *structural* rules
(what imports what, what gets built when). These are the conventions
*inside* a step that those gates can't see — apply them uniformly so a
fresh-context session builds module N the same way it built module 1. The
`reviewer` agent checks these at a phase boundary.

- **Errors are thrown, typed, and domain-named.** A service throws a
  domain error (`OrderNotFoundError`, not a bare `Error` or an HTTP
  exception) — services don't know they're behind HTTP. The controller is
  the only layer that maps domain errors to status codes. Never return
  `null`/`undefined` to signal a failure a caller must branch on.
- **Repository not-found returns `undefined`; the service decides.** A
  `findById` that misses returns `undefined` (a plain absence, not an
  error); the service turns that into a thrown domain error when the
  operation requires the row. Adapters don't throw domain errors — they
  report absence, the service interprets it.
- **Validation lives at the contract boundary, once.** Input is
  Zod-validated at the controller via the ts-rest contract. Past that
  boundary, types are trusted — services and repositories don't re-parse.
  A service-level invariant that isn't expressible in the Zod schema
  (e.g. "can't cancel after payment") is enforced in the service as a
  thrown domain error, not a second validation pass.
- **Multi-write operations are transactional.** A service method that
  writes more than once wraps the writes in one Drizzle transaction,
  passed through the port — partial writes never escape a failed
  operation.
- **Services are pure domain logic.** No logging, no HTTP, no queue
  mechanics inside a service method — those live at the controller /
  adapter edge. A service reads as the business rule and nothing else.

## Friction log

Real friction during a build — an agent's instructions were unclear, a
redline had to be issued twice for the same underlying gap, the user
had to correct the same kind of mistake more than once, or user
feedback implied something was wrong even without a direct correction
(a preference stated once that, read plainly, means an earlier step
missed something) — is signal worth keeping past this session, separate
from the Correction Protocol that fixes it in the moment. Log one entry
via `hedgehog friction add "<note>" [--task <task-id>]` when that
happens: what was tried, what went wrong or was implied, why if visible,
and the commit/message it traces to, all in the note text; pass `--task`
with the layer's task id when the friction traces to one. This is a log,
not a todo list — don't let it block or slow the Loop; log and keep
moving. `tweaker` reads it (via `hedgehog friction list`) once the build
reaches its Stop Condition.

## Correction Protocol

When a downstream step reveals an upstream step was wrong:

1. **Quiesce.** Dispatch nothing new. Let in-flight tasks finish and
   verify normally — do NOT kill running subagents. Release anything
   claimed but not yet started (`hedgehog release <task-id> --owner
   <owner>`).
2. Once nothing is in flight (`hedgehog quiesce` exits 0), patch the
   upstream step directly, in place.
3. Fast-forward every dependent step that breaks, each its own small
   commit. If the patched step lives in a workspace package (e.g.
   `packages/hooks`, `packages/contracts`) that a running `web`/`mobile`
   dev server consumes, run that package's `nx run <pkg>:build` before
   re-verifying — the dev server resolves the package's built `dist/`,
   not its `src/`, so an unbuilt patch looks unchanged to anything
   downstream even though the source is fixed.
4. The commit messages are the explanation.
5. Resume — `hedgehog claim` again.

Quiescing is correct, not a cautious fallback. The conflict predicate
already guarantees a correction cannot collide with in-flight work: if
the correction's scope conflicted with something currently building, the
scheduler would not have co-scheduled it in the first place. Letting
in-flight tasks finish and verify rather than killing them costs nothing
and throws away no progress.

The orchestrating session runs this protocol. A phase-owning agent that
hits the problem reports it rather than correcting across steps: the
commits at step 3 are the session's act, the same way `hedgehog verify`
always is.

Use `conventional-commits` when a correction touches several steps in one
working-tree pass and needs splitting back into per-step commits.

### Post-build entry

The protocol also runs after a build has reached its Stop Condition, when
a `tweaker` session finds that something structural is wrong rather than
something small (`tweaker` routes it here). Steps 2, 3, and 4 are
unchanged. The two ends differ:

- There is nothing to **quiesce** — no task is in flight. Start by naming
  which committed step was wrong and what revealed it.
- There is no loop to **resume**: every task is already `complete`, so
  `hedgehog claim` has nothing to claim. Return to the `tweaker` session
  instead.

Every task the correction touches is already `complete` and stays that
way — a correction is fixed forward in new commits, never by reopening a
finished task. Verify each patched step by running that step's own verify
command directly. Log the correction with `hedgehog friction add` so the
next friction review sees what the build got wrong.

## Phase Transition Checks

Before starting Phase B for a module, confirm:

- `hedgehog status` shows that module's `controller` task `complete`
  (equivalently, a `feat(<module>): api` commit exists).
- The contract is callable and typed (contract tests pass).

Use the `reviewer` agent for this — it checks what the mechanical gate
can't (port discipline, FK-by-ID discipline, contract shape).

Before starting Phase A for a module, confirm it's inside the stated scope
boundary from planning intake (`planner`). If not, stop and ask — and if
the answer is that the scope really should grow, that's `planner`'s
Re-entry pass, which adds it to the graph properly. Don't build a module
the graph doesn't have a task for.

## Rules

- **Phase A closes before Phase B opens.** Every module in scope has a
  working, tested API before any hook or screen starts.
- **Concurrent within a phase, bounded by the scheduler.** Never assume
  two tasks are safe to run together because they look independent — ask
  `hedgehog ready`.
- **Queue infra is conditional twice over** — only if the Queue add-on is
  on for this project at all (per `.hedgehog/addons.yaml`'s `queue.on`),
  and even then only when a given operation genuinely needs async
  (long-running, retries, fan-out); the normal case has no queue.
- **A wrong step gets fixed at its source** — the Correction Protocol, not
  a downstream workaround.
- **Tests gate every commit** in the sequence.
- A module's frontend code (hook, screen) is built after its API is
  committed.
- The screen step doesn't start blank — `ux-planner` runs once per module,
  after the hook is committed, before `front-end-eng` starts the screen.
- `packages/config` is the single source for shared config; a per-app
  override request signals to fix the base config at the source.

## Stop Condition

A build session ends when `hedgehog status` shows every task for every
module in scope `complete` (Phase A and Phase B both closed), or when
scope is ambiguous enough that continuing means guessing — ask one
question and wait.

On the former (a real build completion, not an ambiguity stop), offer a
fresh-context handoff before doing anything else: tell the user the
build is complete, and that clearing context now costs nothing. The
permanent record is the committed intents, friction log, `core.yaml`,
and the commit history itself — not `.hedgehog/hedgehog.db`, which is
gitignored and derived, rebuildable at any time via `hedgehog db
rebuild`. That's what makes the next session cheap.

Before offering that handoff, run `hedgehog boundary` and only declare
the Stop Condition met once it exits 0. Every task showing `complete` is
not sufficient on its own: a lease can be outstanding without a visible
status change, and the working tree can still hold uncommitted work.
`boundary` checks all three — nothing in flight, clean tree, last closed
task completed its intent — and names which one failed when it exits
non-zero. `hedgehog quiesce` covers only the first of the three; it is
the right check mid-correction, not the right check for a handoff.

The same command answers the mid-build question the project instructions
file's **Managing context** section depends on: whether *this* moment,
not just the end of the build, is one to clear the conversation at. Run
it at any point you're considering `/clear`, and start the next session
from `hedgehog boundary --handoff`, which prints where the build is,
what's next and why, and what's blocked, straight from the graph.

Name **both** ways forward, because which one applies depends on what the
user wants next:

- **Adjustments to what's built** — a `tweaker` session, in a *new* chat
  window, not a subagent call inside this one — this session's context
  has been building the whole project and is exactly what "clearing
  context now costs nothing" above means to discard. Tell the user
  plainly: close this chat window and open a new one, then paste this to
  start it:

  > The build is complete. Use the tweaker agent: first review the
  > friction log and ask me for feedback on the build, then take my
  > tweak requests one at a time.

  In the new window, `tweaker` starts clean, reviews the friction log
  (`hedgehog friction list`) once for a possible discipline-improvement
  suggestion, and takes tweak requests one at a time from there.
- **New scope** — a new module, a new feature, anything beyond adjusting
  what exists — goes to `planner`, which runs
  `hedgehog-planning-intake`'s Re-entry pass: it adds intents for the new
  work without re-running planning from scratch, and without disturbing
  anything already built. A completed build is extendable, not sealed.

Don't start making tweaks or planning new scope in the current,
already-large context; that's what the fresh session is for.
