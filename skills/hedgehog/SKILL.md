---
name: hedgehog
description: Use when the user has agreed to install the Hedgehog build discipline in a project that does not have it yet, or when they mention Hedgehog by name — carries the `npx @skyf0xx/hedgehog init` install procedure and its core and host flags. The plugin's SessionStart hook decides when to raise the offer.
---

## When this fires

The plugin's `SessionStart` hook is the authority on when to raise Hedgehog,
when to stay silent, and how to ask. Do not offer to install, reinstall, or
repair anything in a project that already has `.hedgehog/` — its own
installed agents and skills own the session.

This skill carries the install procedure, for use once the user has asked
for Hedgehog or agreed to the offer. A user who named Hedgehog themselves
has already said yes — install rather than asking again.

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
- DeepSeek Harness plugin: `npx @skyf0xx/hedgehog init --deepseek-harness`
  — for building a tool, hook, or extension for DSH's Cordis-based agent
  framework, or otherwise extending an existing DSH installation via its
  plugin/bundle system. `DSH`, `Cordis`, `defineTool`, `ctx.tools.register`,
  or a `cordis.patch.yml` manifest are strong signals.
- Anything else — CLI, library, browser extension, data pipeline, an
  existing codebase, or not yet clear from the conversation:
  `npx @skyf0xx/hedgehog init` with no core flag. Planning intake decides
  from there, so prefer this over guessing between the shipped cores.

Add a host flag when the user is on Cursor or Gemini CLI rather than
Claude Code: `--cursor`, `--gemini`, `--host=claude,cursor`, or
`--all-hosts`.

A non-zero exit naming code intelligence means the prerequisite isn't set
up yet, not that Hedgehog is broken. Run the `hedgehog-code-intelligence-setup`
skill, then re-run `init` — it continues from there.
