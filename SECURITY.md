# Security Policy

## Reporting a vulnerability

Report privately through GitHub's advisory form:

**https://github.com/skyf0xx/hedgehog/security/advisories/new**

That channel is private between you and the maintainers, and it lets a
fix land before the details are public.

If the form is unavailable, open a normal issue with only the affected
component and the words "security — details on request", and a private
channel will be arranged from there. Don't put the reproduction in a
public issue in that case.

Expect an acknowledgement within a few days. You'll get the assessment,
the fix if there is one, and credit in the release notes unless you'd
rather not be named.

## Supported versions

Fixes land on the latest released version. There are no long-term
support branches.

## What's in scope

Hedgehog is a CLI and a package of agent and skill files that a
consuming project installs. The interesting boundaries:

- **The `hedgehog` CLI and build engine** (`bin/`, `src/db/`) — command
  injection, path traversal, anything that escapes a task's declared
  scope, and anything that lets the build graph or a gate be bypassed
  or silently weakened.
- **The installed payload** (`src/agents/`, `src/skills/`,
  `src/templates/`) — these files are copied verbatim into every
  consuming project, so a change that makes an agent take instructions
  from untrusted content, or that weakens a gate a project relies on,
  is a supply-chain issue.
- **The core registry and fetcher** (`src/registry/`) — each core
  (`full-stack-app`, `pwa-app`, `landing-page`, `authored`) ships as its
  own npm package that `init` resolves and fetches; a bug here that lets
  a core install from an unintended source, or that skips validating
  what it fetched, is the same class of supply-chain issue as the
  payload above.
- **Prompt injection reaching an agent** through content it reads — a
  file in the working tree, a fetched page, an issue body. Reports here
  are welcome and are treated as real, not theoretical.

## What's out of scope

- Vulnerabilities in dependencies with no Hedgehog-specific exploit
  path — report those upstream.
- Anything that requires the attacker to already control the machine
  running `hedgehog`, or to have write access to the repository.
- The fact that a core's `verify_command` runs as a shell command.
  That's by design: a core author writes it, and it's the same trust
  level as a `package.json` script.

## A note on local-only impact

Most of Hedgehog's attack surface is local: the inputs are a project's
own files, its `.hedgehog/core.yaml`, and content the agents read. That
lowers severity but doesn't put a report out of scope. In this tool's
model those files are frequently written by AI agents rather than by a
person, so "the input comes from the project itself" is not the same
assurance it would be in a hand-written codebase — an agent that has
been misled is a plausible source of hostile input.
