# Threat model

## What this project does and where untrusted input enters

Hedgehog is a Node.js CLI (`hedgehog`, entry point `bin/cli.mjs`) plus a
package of Markdown agent and skill files. `hedgehog init` and
`hedgehog core install` copy those files into a consuming project and
fetch a "core" package from npm. The other subcommands read and write a
SQLite build graph at `.hedgehog/hedgehog.db` and run git commands
against the project's working tree.

Treat these inputs as untrusted:

- The consuming project's working tree: file names, paths, git refs,
  branch names, commit messages, and the contents of `.hedgehog/`
  (`core.yaml`, `reconciled/*.json`, `community.json`, the database).
  AI agents write most of these files, and an agent that has been
  misled by prompt injection is a realistic source of hostile input.
- CLI arguments that an agent builds from content it read (intent
  titles, task ids, scope globs, friction and debt notes).
- A fetched core package: the tarball from `npm pack` and its
  `hedgehog-core.yaml` manifest (`src/registry/fetch.mjs`,
  `src/registry/manifest.mjs`).
- HTTP requests to the local graph visualization server
  (`src/db/graph-server.mjs`, bound to 127.0.0.1), including requests a
  web page in the user's browser can send to it.

Trusted: `src/registry/cores.json` in this repository, and a core's
`verify_command`, which runs as a shell command by design (the same
trust level as a `package.json` script).

## Components that matter most / least

Most important:

- `src/registry/` — the fetcher and manifest parser. Tarball path
  traversal, writes outside `~/.hedgehog/cores/` or the project root, a
  core installing from an unintended source, or a manifest that is not
  validated.
- `bin/cli.mjs`, `src/db/git.mjs`, `src/db/worktree.mjs`,
  `src/db/commitLock.mjs` — command injection through any value that
  reaches `child_process`, and path traversal out of the project root.
- `src/db/verify.mjs`, `gate.mjs`, `boundary.mjs`, `drift.mjs`,
  `reconcile.mjs`, `rebuild.mjs` — anything that lets a task pass
  verification, escape its declared file scope, or bypass a phase gate
  silently. A silent bypass of a gate is a real finding, not a logic
  nit.
- `src/db/schema.mjs` and every SQL statement in `src/db/` — SQL
  injection, and migration bugs that corrupt or drop a graph.
- `src/hosts/` — `claude-md-merge.mjs` and the host installers write
  into a user's instruction files; a write outside the intended file or
  a destroyed hand-written section matters.
- `src/db/graph-server.mjs` — DNS rebinding, cross-origin requests from
  a browser, path traversal in served files.

Lower priority but in scope:

- `src/agents/`, `src/skills/`, `src/templates/` — Markdown copied
  verbatim into every consuming project. A change that makes an agent
  follow instructions from untrusted content is a supply-chain issue.

Out of scope:

- `vendor-skills/BMAD/` — third-party content vendored from
  BMAD-METHOD; report upstream.
- `repro/`, `scripts/`, `docs/`, `seo-research/`, `badges/` — test,
  release, and documentation tooling that does not ship in the npm
  package.
- `hooks/` runs only inside the Claude Code / Cursor plugin; in scope
  only for command injection through the environment it reads.

## How to exercise it

- The scanner's shell is root. `repro/add-intent-write-failure.mjs`
  relies on a chmod-denied write, which root bypasses, so it fails as
  root and passes as `node`:
  `su node -c 'cd /src && node --experimental-sqlite repro/add-intent-write-failure.mjs'`.
  That failure is not a finding.
- Node 22, run with `--experimental-sqlite`. The image has dev
  dependencies installed and every registered core cached under
  `~/.hedgehog/cores/`, so `init` works offline.
- Scratch project:
  `mkdir /tmp/p && cd /tmp/p && git init && node /src/bin/cli.mjs init --ts-full-stack-app`
  (any core flag from `src/registry/cores.json`, or none)
  then `node --experimental-sqlite /src/bin/cli.mjs <subcommand>`.
- `repro/` holds about 120 standalone reproductions; each drives the
  real CLI against a throwaway git repo. Run one with
  `node --experimental-sqlite repro/<file>.mjs`, or all with
  `npm run repro`. `repro/lib/fixture.mjs` is the shared harness.
- Set `HEDGEHOG_NO_UPDATE_CHECK=1` (already set in the image) so the
  CLI does not try to reach npm.

## How you rate severity

- Critical: code execution or arbitrary file write from a fetched core
  package or from a request to the graph server.
- High: command injection or arbitrary file write/delete outside the
  project root from project files or CLI arguments; a core installing
  from a source other than the one `cores.json` names.
- Medium: a gate, scope check, or verification that can be bypassed
  silently; SQL injection with local-only impact; corruption of the
  build graph or of a user's hand-written instruction file.
- Low: denial of service of the local CLI, crashes on malformed input
  with no further impact, information disclosure limited to the local
  machine.
- Content in the agent/skill Markdown that makes an agent obey untrusted
  input: rate by what the agent can then do, usually medium.

## Anything to leave alone

- A core's `verify_command` running as a shell command.
- Attacks that need the attacker to already control the machine, the
  user's npm registry configuration, or write access to this repository.
- Vulnerabilities in dependencies with no Hedgehog-specific exploit
  path. Hedgehog has no runtime dependencies; ESLint is dev-only.
