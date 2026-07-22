# TODO
 
<!-- 2-3 sentences: what is this project. Full product narrative, scope
boundary, and domain vocabulary live in docs/context.md — every project
has one, written by planner at Intake. -->
 
## Context
 
(fill in per project — see docs/context.md for the full picture)
 
## Bootstrap
 
- [ ] Nx workspace + `packages/config`
- [ ] `packages/db` — Drizzle client
- [ ] `packages/auth` — Better Auth config
- [ ] `apps/api` — Nest shell, global guard, Pino
- [ ] `apps/worker` — BullMQ seam (Redis, no consumers yet)
- [ ] `apps/web` — Next shell, TanStack Query provider
- [ ] `apps/mobile` — Expo shell (only if building for mobile)
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