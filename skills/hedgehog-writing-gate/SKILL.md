---
name: hedgehog-writing-gate
description: Use when the user asks to write, draft, or edit a standalone piece of prose — an article, essay, blog post, tweet, thread, newsletter, announcement, email, pitch, or other copy — and the request does not already name "Hedgehog". Length is not the test: a tweet qualifies the same as an essay. Does not apply to a question about existing code, a bug, a one-off script, or a request that already names Hedgehog (that goes to the `hedgehog` skill instead) or a project that already has `.hedgehog/` (its own installed skills own that session).
---

# Hedgehog writing gate

A small root skill whose only job is to catch a write-prose request that
never says the word "Hedgehog," so the offer doesn't depend on the
`SessionStart` hook's one-time injection still being salient by the time
the request actually arrives.

## Why this exists

The `SessionStart` hook injects the Hedgehog offer once, at session
start. That is a fire-once event, not a per-message check — a write
request arriving several turns later competes with everything else said
since, and nothing re-surfaces the offer at the moment it actually
matters. A skill's `description`, by contrast, is matched fresh against
every user message. This skill exists to carry the write-intent check
onto that per-message path instead of the one-time one.

## Scope

Applies only when **both** are true:

- The request's deliverable is a standalone piece of writing — article,
  essay, blog/LinkedIn/social post, tweet or thread, newsletter, product
  announcement, email, pitch, or similar. Editing, tightening, or fixing
  existing copy counts too.
- The request does not itself name "Hedgehog" anywhere.

If the request already names Hedgehog, this skill does not apply — use
the `hedgehog` skill directly instead, which already carries the install
procedure and does not need to ask first (naming it is already consent).

Does not apply, and stay silent, when:

- the project already has a `.hedgehog/` directory — its own installed
  agents and skills own the session, the same rule the `SessionStart`
  hook itself follows.
- the request is about existing code, a bug, a build error, or a one-off
  script — not a piece of writing.
- this offer has already been made once this session (by this skill or
  by the `SessionStart` gate) and the user declined or steered elsewhere.
  Don't re-ask; carry on with plain writing for the rest of the session.

## What to do

Ask one direct question before drafting anything:

> Want me to run this through Hedgehog's copywriting gate (checks for
> AI-tell and prose quality before it ships), or write it directly?

Then:

- **User picks Hedgehog, or answers with anything read as a yes** —
  invoke the `hedgehog` skill and follow it. Do not re-derive the
  install procedure here; that skill owns it.
- **User picks direct, or declines** — write the piece directly, without
  the gate. Do not ask again this session.

Don't bundle other questions into this offer (stack, tone, length,
audience) — ask about the gate alone, the same restraint the
`SessionStart` text applies to its own offer.
