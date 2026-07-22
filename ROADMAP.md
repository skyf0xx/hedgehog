# Roadmap

Hedgehog ships one opinionated stack today. The roadmap is about where the
discipline extends next — not about loosening the opinions.

## Other agents besides Claude Code

Hedgehog's agents and skills are currently authored for Claude Code
(`.claude/agents/`, `.claude/skills/`). Supporting other coding agents means
the install step (`npx @skyf0xx/hedgehog init`) needs to scaffold each
agent's native format from the same source content, without forking the
discipline itself.

## Other stacks

The current stack (Nx, NestJS, Drizzle, ts-rest, Next.js — see the
Architecture table in `README.md`) is locked because that's what makes the
build order mechanical: Nx module boundaries, phase gates, and lefthook
enforce the sequence instead of relying on the AI to remember it.

Supporting a second stack means finding tooling in that ecosystem capable of
the same mechanical enforcement — not just picking popular alternatives. The
shape of this is a decision tree: given what's being built (e.g. a mobile-only
app, a Python data service), which locked stack enforces the same
schema → contract → repository → service → controller progression?

Until an alternative stack can enforce the build order as mechanically as the
current one does, it doesn't belong in Hedgehog — a stack Hedgehog can't
enforce is just a suggestion, and suggestions are what Hedgehog exists to
replace.
