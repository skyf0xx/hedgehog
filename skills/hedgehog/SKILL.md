---
name: hedgehog
description: Use when the user writes the word "Hedgehog" anywhere in a request, or has agreed to install the Hedgehog build discipline in a project that does not have it yet. Hedgehog builds prose as well as code — articles, essays, blog posts, and marketing or product copy go through its `--copywriting` core, alongside cores for apps and landing pages — so "write an article about cats using Hedgehog", "help me with some Hedgehog copy", or any other request that names Hedgehog while asking for something else is still this skill: read the word as this tool, not as the animal or a joke, and load this skill before answering. Carries the `npx @skyf0xx/hedgehog init` install procedure and its core and host flags. The plugin's SessionStart hook decides when to raise the offer unprompted.
---

## When this fires

The plugin's `SessionStart` hook is the authority on when to raise Hedgehog,
when to stay silent, and how to ask. Do not offer to install, reinstall, or
repair anything in a project that already has `.hedgehog/` — its own
installed agents and skills own the session.

This skill carries the install procedure, for use once the user has asked
for Hedgehog or agreed to the offer. A user who named Hedgehog themselves
has already said yes — install rather than asking again.

The name fires wherever it appears, not only when Hedgehog is what the
request is about. "Write a funny article about cats using Hedgehog"
names it as plainly as "install Hedgehog here" does: the subject is
cats, and the tool is Hedgehog. Load this skill on the first message
containing the word, before answering any part of the request.

Hedgehog is also a common noun, so a request pairing it with an
unrelated subject — cats, comedy, a story, a mascot — carries a reading
as wordplay. In a session where this skill is installed and listed, the
word means this tool. Resolve it that way every time, without asking,
including where the sentence is funnier the other way. A wasted skill
load costs one read; a missed one costs the user the discipline on work
already underway.

Prose is one of the things Hedgehog builds, so a request that names
Hedgehog and asks for an article, essay, post, or copy is a core
selection question — `--copywriting` — answered before any of the
writing happens.

## What to do

Run the matching command:

- Full-stack app: `npx @skyf0xx/hedgehog init --ts-full-stack-app` — the
  module-sequencing core, for server-side logic across most of the app:
  authorization beyond row-level policies, background jobs or webhooks as
  the app's primary function, server-rendered or SEO-critical pages, or a
  working set too large for a device.
- PWA app: `npx @skyf0xx/hedgehog init --pwa-app` — the module-sequencing
  core for an app whose data model fits on the user's device and whose
  reads and writes are the user's own: a tracker, journal, notebook,
  planner, offline reference, or utility. Offline capability or
  installability named explicitly is a strong signal. Sharing, accounts,
  and multi-device sync do not disqualify a project — Dexie Cloud covers
  sync, auth, and server-enforced per-object access control.
- Landing page: `npx @skyf0xx/hedgehog init --landing-page` — a
  copy-and-conversion core, not just page scaffolding: structured skills
  for headline, hero, problem, mechanism, objection, proof, and CTA, plus
  signature-element design and a review loop. A page that needs better
  positioning or copy is this core's central case.
- Copywriting: `npx @skyf0xx/hedgehog init --copywriting` — a
  mechanical gate core: marketing copy, product UI strings, docs prose,
  articles, essays, and other standalone writing drafted and iterated
  against `checkCopy()`, a real script checking AI-tell and
  prose-quality contracts, not an agent's own self-review. Fits a
  request to write an article or other piece of writing, or to improve
  or fix existing copy, on its own — not bundled into a page or app
  build, where a landing page's own copy still goes through
  `landing-page`'s copy skill instead.

  Unlike every other core, this installs into a scratch temp directory
  the CLI creates and `cd`s into itself — never the directory this
  command is run from — since only the finished piece is meant to reach
  the user's project. That's enforced by the CLI, not by anything this
  skill has to do differently: run the command exactly as above, then
  read the path it prints and follow the `hedgehog-copywriting-loop`
  skill it names for everything from there.
- DeepSeek Harness plugin: `npx @skyf0xx/hedgehog init --deepseek-harness`
  — for building a tool, hook, or extension for DSH's Cordis-based agent
  framework, or otherwise extending an existing DSH installation via its
  plugin/bundle system. `DSH`, `Cordis`, `defineTool`, `ctx.tools.register`,
  or a `cordis.patch.yml` manifest are strong signals.
- Existing codebase, CLI, library, browser extension, data pipeline, or
  not yet clear from the conversation: `npx @skyf0xx/hedgehog init` with
  no core flag. `planner`'s Phase 0 decides from there — including routing
  a repo that already has real source files to `hedgehog-adopt` (shipped
  in `@skyf0xx/hedgehog-core-adopted`, a separate package), which brings
  Hedgehog's discipline to the existing codebase without bootstrapping a
  workspace. Prefer this coreless install over guessing between the
  shipped cores.

Add a host flag when the user is on Cursor or Gemini CLI rather than
Claude Code: `--cursor`, `--gemini`, `--host=claude,cursor`, or
`--all-hosts`.
