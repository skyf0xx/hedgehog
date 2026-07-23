#!/usr/bin/env bash
# Regenerates src/golden-core/ from scratch — the deterministic core
# output that `hedgehog-bootstrap-core` copies into every project instead
# of generating it live. Run this by hand whenever a core dependency
# (Nx, NestJS, Next, Drizzle, ...) needs bumping. Not run automatically,
# not part of the installer's runtime path.
#
# What this does, in order: scaffold the Nx workspace + packages/config
# (with the full enforcement config baked in), packages/db, apps/api,
# apps/web. Every hand-edit below exists because a real run hit it; see
# `hedgehog-bootstrap-core`'s "Known issues baked into golden-core"
# section for the why behind each one. Diff the result against the
# current src/golden-core/ before committing — don't assume a clean run
# means nothing changed upstream in a way that matters.
#
# Usage: scripts/regenerate-golden-core.sh [scratch-dir]
#   scratch-dir defaults to a fresh temp directory.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="${1:-$(mktemp -d /tmp/hedgehog-golden-core.XXXXXX)}"

echo "Regenerating golden-core in: $SCRATCH"
mkdir -p "$SCRATCH"
cd "$SCRATCH"

if [ -f "$SCRATCH/nx.json" ]; then
  echo "Refusing to run against a non-empty scratch dir with an existing nx.json: $SCRATCH" >&2
  exit 1
fi

command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }
command -v docker >/dev/null || echo "Warning: docker not found — skipping local infra smoke test at the end."

# ── Step 1: Nx workspace + packages/config ──────────────────────────────

cat > package.json <<'EOF'
{
  "name": "app",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.0.0"
}
EOF

npx nx@latest init
pnpm add -D @nx/js

# nx init doesn't reliably respect the locked package manager — verify.
if [ -f package-lock.json ]; then
  rm package-lock.json
  pnpm install
fi

cat > pnpm-workspace.yaml <<'EOF'
packages:
  - 'packages/*'
  - 'apps/*'
EOF

npx nx g @nx/js:lib packages/config --bundler=none --unitTestRunner=vitest

# esbuild postinstall version collision (see hedgehog-bootstrap-core's
# "Known issues" — @nx/vite's optional esbuild peer vs. drizzle-kit's
# hard-pinned dependency). Re-check drizzle-kit's current range
# (`pnpm view drizzle-kit dependencies.esbuild`) before bumping this.
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.pnpm = { overrides: { esbuild: '0.25.12' } };
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

cat > docker-compose.yml <<'EOF'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
    ports:
      - '5432:5432'
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  postgres-data:
EOF

echo ""
echo "=== Manual steps required here (not scriptable — see hedgehog-bootstrap-core SKILL.md) ==="
echo "  - packages/config/env.schema.ts: core fields only (DATABASE_URL, NODE_ENV)"
echo "  - packages/config/eslint-base.js: @nx/enforce-module-boundaries + depConstraints"
echo "    for scope:api, scope:web, scope:db/type:adapter, scope:contracts,"
echo "    scope:hooks, scope:shared, type:service, type:port, type:util"
echo "  - packages/config/prettier.js: singleQuote only, NO prettier-plugin-tailwindcss"
echo "  - @nx/js/typescript plugin registration in nx.json (typecheck target)"
echo "  - composite/declaration on packages/config's tsconfig.lib.json + tsconfig.spec.json"
echo "  - lefthook.yml + commitlint.config.cjs + tools/phase-gate.cjs +"
echo "    .github/workflows/phase-gate.yml"
echo "Pausing here — finish these by hand, then re-run this script with"
echo "  the same scratch dir to continue from step 2."
echo "==="
read -r -p "Press enter once the manual step-1 wiring above is done: " _

# ── Step 2: packages/db ──────────────────────────────────────────────────

npx nx g @nx/js:lib packages/db --bundler=none --unitTestRunner=vitest
pnpm add drizzle-orm pg
pnpm add -D drizzle-kit drizzle-zod

echo "Manual: wire packages/db's Drizzle client to loadEnv(). Tag scope:db, type:adapter."
read -r -p "Press enter once packages/db is wired: " _

# ── Step 4: apps/api ──────────────────────────────────────────────────────

npx nx g @nx/nest:app apps/api
pnpm add nestjs-pino pino-http

echo "Manual: wire nestjs-pino, call loadEnv() in main.ts, add a health check."
echo "Manual: convert apps/api-e2e from Jest to Vitest, rename its target to"
echo "  an explicit 'e2e' (not the inferred 'test'), exclude it from @nx/vitest's"
echo "  auto-inference in nx.json. Tag scope:api."
read -r -p "Press enter once apps/api is wired: " _

# ── Step: apps/web ────────────────────────────────────────────────────

npx nx g @nx/next:app apps/web --no-interactive

pnpm --filter web add \
  @tanstack/react-query \
  class-variance-authority clsx tailwind-merge lucide-react @radix-ui/react-slot \
  tailwindcss @tailwindcss/postcss postcss

# Known issue: apps/web-e2e's generated tsconfig.json has no `types`
# array, so playwright.config.mts's use of process.env / import.meta
# fails typecheck. Add node types explicitly.
node -e "
const fs = require('fs');
const p = 'apps/web-e2e/tsconfig.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.compilerOptions.types = ['node'];
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"

# Known issue: apps/web/package.json needs "type": "module" to match
# apps/web/.prettierrc.js being ESM.
node -e "
const fs = require('fs');
const p = 'apps/web/package.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.type = 'module';
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"

# Known issue: prettier-plugin-tailwindcss must stay on ^0.7.4 — 0.8.x's
# async parser.preprocess breaks under Prettier's sync parser-API
# contract (crashes with "e.charAt is not a function" on every file).
# Re-check whether this is fixed upstream before bumping.
pnpm --filter web add -D prettier-plugin-tailwindcss@^0.7.4

echo ""
echo "=== Manual steps required for apps/web (see hedgehog-bootstrap-core) ==="
echo "  - apps/web/postcss.config.mjs: @tailwindcss/postcss plugin"
echo "  - apps/web/src/app/global.css: @import 'tailwindcss' + CSS variable"
echo "    theme (light/dark, shadcn default token values)"
echo "  - apps/web/components.json, src/lib/utils.ts (cn()), a hand-written"
echo "    button.tsx from shadcn's published source"
echo "  - IMPORTANT: any component importing Radix's Slot (asChild pattern)"
echo "    needs 'use client' as its first line, even if asChild is never set"
echo "    on that render path — see hedgehog-bootstrap-core's known issues."
echo "  - apps/web/src/app/providers.tsx: TanStack Query provider, wired at"
echo "    the root layout (layout.tsx stays a server component; Providers"
echo "    is the 'use client' wrapper)"
echo "  - apps/web/.prettierrc.js: extends packages/config/prettier.js,"
echo "    adds prettier-plugin-tailwindcss AND sets tailwindStylesheet"
echo "    (Tailwind v4 has no tailwind.config.js to autodetect)"
echo "  - Do NOT run 'pnpm dlx shadcn@latest init' against apps/web directly —"
echo "    it has no per-app package.json for the CLI to detect and will"
echo "    scaffold a corrupted nested create-next-app project instead."
echo "  - depConstraints: add scope:web -> [scope:contracts, scope:hooks, scope:shared]"
echo "==="
read -r -p "Press enter once apps/web is fully wired: " _

# ── Verify ──────────────────────────────────────────────────────────────

pnpm install
npx nx reset
npx nx run-many -t typecheck,lint,test
npx nx format:write
rm -rf apps/web/.next .nx
npx nx build web
rm -rf apps/web/.next .nx

echo ""
echo "=== Verification passed. Sync into src/golden-core/: ==="
echo "  rsync -a --exclude=node_modules --exclude=.git --exclude=.nx \\"
echo "    --exclude=dist --exclude=out-tsc --exclude='*.tsbuildinfo' \\"
echo "    --exclude=.env --exclude='apps/web/.next' \\"
echo "    '$SCRATCH/' '$REPO_ROOT/src/golden-core/'"
echo ""
echo "Then diff against the previous src/golden-core/ and commit deliberately —"
echo "don't blind-overwrite without reviewing what changed upstream."
