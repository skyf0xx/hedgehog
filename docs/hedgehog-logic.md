# Hedgehog: Logic (Enforcement)
 
A reference for the config that makes Stack and Order mechanically true.
Every rule below is a compiler error, a lint failure, or a blocked commit.
 
## 1. Nx Module Boundaries
 
Encodes "service imports only ports" as a build-time failure.
`@nx/enforce-module-boundaries` reasons at Nx-project granularity, so each
domain module's repository and service are their own Nx lib; `apps/api`
itself is wiring (controllers + module registration) that imports those
libs. This makes cross-module isolation (Order doc — FK-by-ID only)
mechanically true.
 
**Tags:**
 
```
apps/api          → scope:api
apps/worker        → scope:worker
apps/web            → scope:web
apps/mobile         → scope:mobile
packages/db          → scope:db,        type:adapter
packages/contracts   → scope:contracts, type:contract
packages/hooks       → scope:hooks,     type:hook
packages/auth        → scope:auth,      type:adapter
packages/shared      → scope:shared,    type:util
libs/<module>/port      → scope:<module>, type:port
libs/<module>/repository → scope:<module>, type:adapter
libs/<module>/service    → scope:<module>, type:service
```

One `libs/<module>/` triplet per domain module (Order doc: one table = one
module) — e.g. `libs/orders/port`, `libs/orders/repository`,
`libs/orders/service`.
 
**Root eslint.config.js rule:**
 
```js
'@nx/enforce-module-boundaries': ['error', {
  depConstraints: [
    // domain services never import adapters directly — only ports
    { sourceTag: 'type:service', onlyDependOnLibsWithTags: ['type:port', 'type:util'] },
    // web/mobile never import db or api internals — only contracts + hooks
    { sourceTag: 'scope:web',    onlyDependOnLibsWithTags: ['scope:contracts', 'scope:hooks', 'scope:shared'] },
    { sourceTag: 'scope:mobile', onlyDependOnLibsWithTags: ['scope:contracts', 'scope:hooks', 'scope:shared'] },
    // worker only reaches domain logic through ports, same as api
    { sourceTag: 'scope:worker', onlyDependOnLibsWithTags: ['type:port', 'type:util', 'scope:shared'] },
  ],
}],
```
 
Building out of Order order (e.g. a controller before a service exists, or a
hook reaching into `apps/api` directly) fails `nx lint`.
 
## 2. Commit Gate (lefthook + commitlint)
 
Enforces Unit of Work: one coherent change, tested, conventionally
committed. Runs on staged files only — fast regardless of repo size.
 
**lefthook.yml:**
 
```yaml
pre-commit:
  parallel: true
  commands:
    typecheck:
      glob: "*.{ts,tsx}"
      run: npx nx affected -t typecheck --files={staged_files}
    lint:
      glob: "*.{ts,tsx}"
      run: npx nx affected -t lint --files={staged_files}
    test:
      glob: "*.{ts,tsx}"
      run: npx nx affected -t test --files={staged_files}
 
commit-msg:
  commands:
    commitlint:
      run: npx commitlint --edit {1}
```
 
**commitlint.config.js:**
 
```js
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', [
      'domain', 'db', 'contracts', 'auth', 'hooks',
      'api', 'worker', 'web', 'mobile', 'config',
    ]],
  },
};
```
 
A commit that fails typecheck, lint, or test does not happen. A commit
exists once it compiles and passes.
 
## 3. Env Validation (fail fast)
 
Types-first extended to config. Boot fails immediately on a missing or
malformed env var.
 
**packages/config/env.schema.ts:**
 
```ts
import { z } from 'zod';
 
export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  REDIS_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']),
});
 
export type Env = z.infer<typeof envSchema>;
 
export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(parsed.error.format());
    process.exit(1);
  }
  return parsed.data;
}
```
 
Called once, at the top of `apps/api/src/main.ts` and `apps/worker/src/main.ts`.
 
## 4. Phase Gate (Order enforcement in CI)
 
Encodes "Phase A closes before Phase B opens" as a CI check. Blocks a PR
that introduces a `feat(domain): hooks` or `feat(domain): screen-*` commit
for a domain with no prior `feat(domain): api` commit on the branch.
 
**.github/workflows/phase-gate.yml (logic sketch):**
 
```yaml
- name: Enforce Phase A before Phase B
  run: |
    node tools/phase-gate.js
```
 
**tools/phase-gate.js (logic):**
 
```
for each commit in PR:
  if commit matches /^feat\(([a-z-]+)\): (hooks|screen-\w+)/:
    domain = capture group 1
    fail unless a commit /^feat\(domain\): api/ for that domain
      already exists on main or earlier in this branch
```
 
## 5. Locked Format/Lint Config
 
One shared config, extended everywhere.
 
- `packages/config/eslint-base.js` — flat config, extended by every app/lib.
- `packages/config/prettier.js` — includes `prettier-plugin-tailwindcss`.
- A per-app override request is a signal to fix the base config at the
  source.
