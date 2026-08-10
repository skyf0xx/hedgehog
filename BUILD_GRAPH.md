# The build graph

Hedgehog stores its build state in one SQLite database:

```text
.hedgehog/hedgehog.db
```

It has five main tables:

| Table           | Purpose                                           |
| --------------- | -------------------------------------------------- |
| `intents`       | What is being built                               |
| `tasks`         | The work to perform, plus who currently leases it |
| `dependencies`  | What must finish first                            |
| `verifications` | The result of each `verify_command` run           |
| `artifacts`     | The files each completed task produced            |

The rest of the system is built on top of these tables.

## 1. Intents become tasks

An **intent** is a domain module, such as `orders` or `billing`.

A **core** (`.hedgehog/core.yaml`) defines the layers used to build an intent:

```text
schema → repository → service → controller → screen
```

`hedgehog plan` combines the two.

For each intent, it creates one task for each layer:

```text
orders
  schema → repository → service → controller → screen

billing
  schema → repository → service → controller → screen
```

Dependencies connect the tasks within each intent. Intents can also declare dependencies on other intents.

Layers marked `once: true` are created only once rather than once per intent.

Each task also carries the requirements that apply to it: rules, constraints, acceptance criteria, and its allowed scope.

## 2. Tasks have one lifecycle

A task is a row in `tasks`.

```text
planned → ready → building → verifying → complete
```

A task can also become `blocked` when verification fails or its scope is violated.

The state is enough to describe where the task is in the build.

## 3. Readiness comes from dependencies

Hedgehog does not need a separate scheduler.

A task is ready when:

* it is `planned` or `ready`
* nobody currently holds its lease
* every dependency is `complete`

Conceptually:

```text
task
 ├─ status is planned/ready?
 ├─ no active lease?
 └─ all dependencies complete?
          ↓
        ready
```

The CLI evaluates this directly against SQLite whenever it looks for work.

## 4. Agents claim ready work

An agent asks for a task:

```bash
hedgehog claim --owner me
```

Hedgehog finds a ready task and creates a lease.

The agent receives the information it needs to work:

```text
objective
requirements
allowed scope
verify command
```

The agent then builds the task.

## 5. Verification controls completion

When the agent is finished:

```bash
hedgehog verify <task> --owner me
```

Verification happens in order:

```text
Git diff
   ↓
scope check
   ↓
verify_command
   ↓
commit
   ↓
complete
```

If the agent changed files outside its allowed scope, the task is blocked.

If verification fails, the task is blocked.

If everything passes, Hedgehog commits the allowed changes and marks the task complete.

## 6. Multiple agents can work at once

The lease is what makes parallel work possible.

A task being built or verified has:

```text
lease_owner
lease_expires_at
```

Another agent cannot claim the same task while its lease is active.

Because agents claim different ready tasks, several can work concurrently without a separate queue or lock server.

## 7. Git is the durable record

A completed task produces a Git commit containing its in-scope changes.

This gives Hedgehog two records of the build:

```text
SQLite → current build state
Git    → what was actually built
```

The database can therefore be rebuilt from the commit history.

## 8. Verification is mechanical; review is judgment

`hedgehog verify` runs on every task, but only checks what a machine can
check: scope and exit code. A separate `reviewer` role covers what it
can't — boundaries, granularity, contract shape, security — at a few
checkpoints instead of every commit:

* before Phase B opens for a module
* when a layer closes on an authored core
* during the Correction Protocol, when an upstream step turns out wrong

On one module, the two gates sit at different points in the same chain:

```text
schema        verify ✓
repository    verify ✓
service       verify ✓
controller    verify ✓
              reviewer ── Phase Transition Check
screen        verify ✓   (Phase B)
```

The reviewer never edits code. It reports findings, and a Block goes back
through the Correction Protocol to be fixed at its source.

The important relationship is:

```text
dependencies → readiness
leases       → concurrency
Git commits  → completion
```

The build graph is not a separate scheduler sitting on top of the codebase.

The graph, task ownership, verification, and completion all come from the same small set of primitives.
