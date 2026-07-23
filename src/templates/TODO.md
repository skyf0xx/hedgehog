# TODO
 
<!-- 2-3 sentences: what is this project. Full product narrative, scope
boundary, and domain vocabulary live in docs/context.md — every project
has one, written by planner at Intake. -->
 
## Context
 
(fill in per project — see docs/context.md for the full picture)
 
## Bootstrap

<!-- Core steps (always run) and add-on steps (planner marks each
on/skipped at Intake, per docs/context.md's Add-ons note) below. A
skipped add-on gets checked off as skipped, not left unchecked. -->

- [ ] Nx workspace + `packages/config` (incl. `docker-compose.yml` for local Postgres) — core
- [ ] `packages/db` — Drizzle client — core
- [ ] `packages/auth` — Better Auth config — Auth add-on (fill in: on / skipped, not in scope)
- [ ] `apps/api` — Nest shell, Pino (+ global guard if Auth is on) — core
- [ ] `apps/worker` — BullMQ seam, Redis (no consumers yet) — Queue add-on (fill in: on / skipped, not in scope)
- [ ] `apps/web` — Next shell, TanStack Query provider — core
- [ ] `apps/mobile` — Expo shell — Mobile add-on (fill in: on / skipped, not in scope)
## Phase A — Backend
 
<!-- One subsection per module in scope. Do not add hooks/screens here —
that's Phase B, and doesn't start until every module below is checked. -->
 
### <module-name>
 
- [ ] schema
- [ ] contract
- [ ] repository
- [ ] service
- [ ] api (controller)
- [ ] queue (only if this operation genuinely needs async)
## Phase B — Frontend
 
<!-- Do not touch this section until every module above has "api" checked. -->
 
### <module-name>
 
- [ ] hooks
- [ ] ux-planner — writes docs/design/<module-name>.md; ask for a
      mockup/screenshot/Stitch or Figma export here if one exists
- [ ] screen-web
- [ ] screen-mobile (only if building for mobile)