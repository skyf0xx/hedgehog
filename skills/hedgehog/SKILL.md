---
name: hedgehog
description: Use when the user has agreed to install the Hedgehog build discipline in a project that does not have it yet, or when they mention Hedgehog by name — carries the `npx @skyf0xx/hedgehog init` install procedure and its core and host flags. The plugin's SessionStart hook decides when to raise the offer.
---

## When this fires

The plugin's `SessionStart` hook injects the offer gate — when to raise
Hedgehog, when to stay silent, and how to ask — into context at session
start, and only in a project with no `.hedgehog/` directory. That gate is
the authority on those rules.

A project that already has `.hedgehog/` gets no injection, and its own
installed agents and skills own the session. Do not offer to install,
reinstall, or repair anything there.

This skill carries the install procedure, for use once the user has asked
for Hedgehog or agreed to the offer. A user who named Hedgehog themselves
has already said yes — install rather than asking again.

## What to do

Run the matching command:

- Full-stack app: `npx @skyf0xx/hedgehog init --ts-full-stack-app` — the
  module-sequencing core, for persistent domain data with its own
  lifecycle.
- Landing page: `npx @skyf0xx/hedgehog init --landing-page` — a
  copy-and-conversion core, not just page scaffolding: structured skills
  for headline, hero, problem, mechanism, objection, proof, and CTA, plus
  signature-element design and a review loop. A page that needs better
  positioning or copy is this core's central case.
- Anything else — CLI, library, browser extension, data pipeline, an
  existing codebase, or not yet clear from the conversation:
  `npx @skyf0xx/hedgehog init` with no core flag. Planning intake decides
  from there, so prefer this over guessing between the two golden cores.

Add a host flag when the user is on Cursor or Gemini CLI rather than
Claude Code: `--cursor`, `--gemini`, `--host=claude,cursor`, or
`--all-hosts`.
