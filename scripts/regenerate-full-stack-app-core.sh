#!/usr/bin/env bash
# Regenerates src/golden-cores/full-stack-app/ from scratch — the deterministic full-stack-app core
# output that `hedgehog-bootstrap-core` copies into every project instead
# of generating it live. Run this by hand whenever a core dependency
# (Nx, NestJS, Next, Drizzle, ...) needs bumping. Not run automatically,
# not part of the installer's runtime path.
#
# Nx is pinned exactly (`nx@23.1.0` below, matching every `@nx/*` pin in
# the golden core's own package.json) — a golden-core regen never floats
# to whatever Nx last published. Bumping Nx is a deliberate edit to the
# version below, at which point also check whether the vendored Nx skills
# (src/skills/nx-generate, nx-run-tasks, nx-workspace,
# link-workspace-packages, adapted from nrwl/nx-ai-agents-config — see
# README.md Credits) have drifted from upstream and are worth re-pulling.
# Not automatic; check by hand.
#
# What this does, in order: scaffold the Nx workspace + packages/config
# (with the full enforcement config baked in), packages/db, apps/api,
# apps/web. Every hand-edit below exists because a real run hit it; see
# `hedgehog-bootstrap-core`'s "Known issues baked into the full-stack-app
# core" section for the why behind each one. Diff the result against the
# current src/golden-cores/full-stack-app/ before committing — don't
# assume a clean run means nothing changed upstream in a way that matters.
#
# Usage: scripts/regenerate-full-stack-app-core.sh [scratch-dir]
#   scratch-dir defaults to a fresh temp directory.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="${1:-$(mktemp -d /tmp/hedgehog-full-stack-app-core.XXXXXX)}"

echo "Regenerating full-stack-app core in: $SCRATCH"
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

npx nx@23.1.0 init
pnpm add -D @nx/js@23.1.0

# Nx just bumped — check github.com/nrwl/nx-ai-agents-config/tree/main/skills
# for drift against src/skills/{nx-generate,nx-run-tasks,nx-workspace,
# link-workspace-packages} before continuing (see header comment above).

# nx init doesn't reliably respect the locked package manager — verify.
if [ -f package-lock.json ]; then
  rm package-lock.json
  pnpm install
fi

cat > pnpm-workspace.yaml <<'EOF'
packages:
  - 'packages/*'
  - 'apps/*'
  # Domain libs land as libs/<module>/<layer> during Phase A. Declared up
  # front so the first module through the repository layer doesn't have to
  # edit this file before pnpm will link its workspace:* deps.
  - 'libs/*/*'
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
echo "  - packages/config/env.schema.ts: core fields only (DATABASE_URL, NODE_ENV,"
echo "    WEB_ORIGIN)"
echo "  - .env.example at the repo root: DATABASE_URL, NODE_ENV, WEB_ORIGIN"
echo "    (rsync excludes .env but NOT .env.example — an absent one deletes it)"
echo "  - packages/config/eslint-base.js: @nx/enforce-module-boundaries with"
echo "    enforceBuildableLibDependency FALSE (contracts/hooks are source-only),"
echo "    depConstraints for type:service, type:adapter, type:contract, type:hook,"
echo "    type:util, scope:web, scope:mobile, scope:worker, scope:api — and the"
echo "    no-restricted-imports blocks carrying port discipline (libs/*/service"
echo "    and apps/api minus *.module.ts). There is no type:port project: the"
echo "    repository layer lands port and adapter in one lib."
echo "  - packages/config/prettier.js: singleQuote only, NO prettier-plugin-tailwindcss"
echo "  - @nx/js/typescript plugin registration in nx.json (typecheck target)"
echo "  - composite/declaration on packages/config's tsconfig.lib.json + tsconfig.spec.json"
echo "  - lefthook.yml + commitlint.config.cjs + tools/phase-gate.cjs +"
echo "    .github/workflows/phase-gate.yml"
echo "  - tsconfig.base.json (nx init generates nodenext/nodenext by default):"
echo "    set module/moduleResolution to esnext/bundler, and drop .js extensions"
echo "    from every relative import specifier in generated/hand-written source"
echo "    — Turbopack can't resolve a nodenext-style .js specifier across a"
echo "    pnpm workspace-package boundary (apps/web -> packages/*)."
echo "  - apps/web/package.json: nx.tags [\"scope:web\"] — the depConstraints"
echo "    sourceTag: 'scope:web' rule above is inert without it, and"
echo "    @nx/enforce-module-boundaries fails apps/web on any workspace import."
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

pnpm add -D @nx/nest@23.1.0
npx nx g @nx/nest:app apps/api --unitTestRunner=vitest
pnpm add nestjs-pino pino-http

# @ts-rest/nest wires the ts-rest contract (packages/config's @ts-rest/core)
# into NestJS controllers — backend-eng's Step 5. @ts-rest/core is added
# here too, pinned to the same version as packages/config, so pnpm dedupes
# to one copy instead of resolving @ts-rest/nest's own semver range to a
# second, mismatched @ts-rest/core (breaks its peer dependency check).
pnpm --filter api add @ts-rest/core@3.53.0-rc.1 @ts-rest/nest@3.53.0-rc.1

# db dependency: the controller layer imports packages/db by construction
# (core.yaml), so apps/api needs it wired at generation time, not left for
# the first module's controller task to discover missing.
pnpm --filter api add db@workspace:*
node -e "
const fs = require('fs');
const p = 'apps/api/tsconfig.app.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.references.push({ path: '../../packages/db/tsconfig.lib.json' });
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"

# @nx/nest:app --unitTestRunner=vitest lands vitest.config.mts and
# tsconfig.spec.json, but NestJS test modules (decorated classes,
# Test.createTestingModule) need experimentalDecorators/emitDecoratorMetadata,
# which the generator only sets on tsconfig.app.json — add them to
# tsconfig.spec.json too, and reference tsconfig.app.json (not tsconfig.lib.json,
# which apps/api doesn't have) so the spec project sees the app's own types.
node -e "
const fs = require('fs');
const p = 'apps/api/tsconfig.spec.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.compilerOptions.experimentalDecorators = true;
j.compilerOptions.emitDecoratorMetadata = true;
j.references = [{ path: './tsconfig.app.json' }];
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"

# Wire tsconfig.spec.json into apps/api/tsconfig.json's references —
# matching packages/db/tsconfig.json and packages/config/tsconfig.json's
# own pattern (each references both its main config and its spec config
# as sibling TS project references, so `tsc -b` picks up the spec project
# without needing to be told about it separately).
node -e "
const fs = require('fs');
const p = 'apps/api/tsconfig.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.references.push({ path: './tsconfig.spec.json' });
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"

# Pin apps/api/vitest.config.mts to exactly packages/db's model (name,
# cacheDir, environment: 'node') regardless of what the generator's
# default vitest.config.mts looks like — Nest has no browser code, so
# node is the correct environment (unlike apps/web's jsdom override below).
cat > apps/api/vitest.config.mts <<'EOF'
import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/api',
  test: {
    name: 'api',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
EOF

# Self-registering controller barrel: apps/api/src/app/app.module.ts must
# never take a per-module edit (core.yaml's controller layer scope is
# apps/api/src/app/{module}/** — module-disjoint by construction, and a
# shared file outside every module's scope is invisible to the scheduler's
# conflict check, so two modules hand-editing one file would race
# undetected). tools/generate-feature-modules.cjs globs
# apps/api/src/app/*/*.module.ts and writes apps/api/src/app/feature-modules.ts
# — a generated barrel, never hand-edited, wired as an Nx target that
# `build`/`typecheck`/`test` depend on.
mkdir -p tools
cat > tools/generate-feature-modules.cjs <<'SCRIPT_EOF'
#!/usr/bin/env node
/**
 * Regenerates apps/api/src/app/feature-modules.ts — the barrel that lists
 * every domain module's NestJS `@Module` class for AppModule to import.
 *
 * Written as CommonJS (`.cjs`) deliberately: root `package.json` sets
 * `"type": "module"`, so a plain `.js` file here would be parsed as ESM
 * and `require`/`module.exports` below would fail with "require is not
 * defined".
 *
 * Why generated rather than hand-edited: the controller layer's scope is
 * `apps/api/src/app/{module}/**` (core.yaml) — module-disjoint by
 * construction, so two modules' controller tasks never touch the same
 * file. AppModule itself is exclusive: true / once (see core.yaml), so it
 * can't carry a per-module edit either. A file that every module's
 * controller task hand-edited (even one line each) would sit outside
 * every task's declared scope, invisible to the scheduler's conflict
 * check (src/db/conflict.mjs only compares declared scope globs) — two
 * concurrent module builds editing it would look conflict-free to the
 * scheduler while actually racing on one file. Generating it instead
 * removes the shared edit entirely: every module writes only inside its
 * own `apps/api/src/app/{module}/` directory (a `{module}.module.ts`
 * file, discovered here by naming convention), and this script is the
 * only thing that ever writes feature-modules.ts.
 *
 * Convention: any file matching apps/api/src/app/*\/*.module.ts (module
 * directories only, one level deep — not app.module.ts itself) is treated
 * as a domain module and must have a named export ending in "Module".
 *
 * Run via the `generate-feature-modules` Nx target, which `test` and
 * `build` depend on (nx.json targetDefaults) — never run by hand as part
 * of normal development.
 */
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.join(__dirname, '..', 'apps', 'api', 'src', 'app');
const OUTPUT_FILE = path.join(APP_DIR, 'feature-modules.ts');
const HEADER =
  '// GENERATED FILE — do not hand-edit. Regenerated by\n' +
  '// tools/generate-feature-modules.cjs (the generate-feature-modules Nx\n' +
  '// target, which test and build depend on) from every\n' +
  '// apps/api/src/app/*/*.module.ts file on disk. A module directory\'s\n' +
  '// controller layer only ever creates its own *.module.ts inside its own\n' +
  '// directory — never edits this file.\n';

function findModuleFiles() {
  if (!fs.existsSync(APP_DIR)) return [];
  const entries = fs.readdirSync(APP_DIR, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const moduleDir = path.join(APP_DIR, entry.name);
    for (const file of fs.readdirSync(moduleDir)) {
      if (file.endsWith('.module.ts')) {
        files.push(path.join(entry.name, file.replace(/\.ts$/, '')));
      }
    }
  }
  return files.sort();
}

function exportNameFor(relativePath) {
  // "tasks/tasks.module" -> "TasksModule". Every domain module generator
  // (Nx's @nx/nest:module or hand-authored) names its class
  // `<PascalCase>Module` to match the file's own `<kebab>.module.ts` name
  // — the same convention @nx/nest itself uses.
  const base = path.basename(relativePath).replace(/\.module$/, '');
  const pascal = base
    .split('-')
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('');
  return `${pascal}Module`;
}

function main() {
  const moduleFiles = findModuleFiles();
  const imports = [];
  const names = [];

  for (const relativePath of moduleFiles) {
    const importName = exportNameFor(relativePath);
    imports.push(`import { ${importName} } from './${relativePath}';`);
    names.push(importName);
  }

  const body =
    names.length > 0
      ? `export const featureModules = [${names.join(', ')}];\n`
      : 'export const featureModules = [];\n';

  const content =
    HEADER +
    (imports.length > 0 ? '\n' + imports.join('\n') + '\n' : '') +
    '\n' +
    body;

  fs.writeFileSync(OUTPUT_FILE, content);
  console.log(
    `Generated ${path.relative(process.cwd(), OUTPUT_FILE)} with ${names.length} feature module(s).`,
  );
}

main();
SCRIPT_EOF
node tools/generate-feature-modules.cjs

node -e "
const fs = require('fs');
const p = 'apps/api/src/app/app.module.ts';
fs.writeFileSync(p, \`import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { HealthController } from './health.controller';
// Generated by tools/generate-feature-modules.cjs (see that file's header)
// from every apps/api/src/app/*/*.module.ts on disk — never hand-edited,
// so no domain module's controller task ever edits this file or
// app.module.ts itself to register.
import { featureModules } from './feature-modules';

@Module({
  imports: [LoggerModule.forRoot(), ...featureModules],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
\`);
"

# Wire the generate-feature-modules target so build/typecheck/test always
# regenerate feature-modules.ts before running (Nx-cached, so a no-op
# rerun is free). typecheck/test are inferred targets with no explicit
# apps/api/package.json block — the dependency is declared once in
# nx.json's targetDefaults instead, safe on projects with no matching
# target (Nx skips a missing dependsOn target rather than failing).
node -e "
const fs = require('fs');
const p = 'apps/api/package.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.nx.targets = {
  'generate-feature-modules': {
    executor: 'nx:run-commands',
    cache: true,
    inputs: ['{projectRoot}/src/app/*/*.module.ts'],
    outputs: ['{projectRoot}/src/app/feature-modules.ts'],
    options: {
      command: 'node tools/generate-feature-modules.cjs',
      cwd: '{workspaceRoot}',
    },
  },
  ...j.nx.targets,
};
j.nx.targets.build.dependsOn = ['generate-feature-modules'];
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"
node -e "
const fs = require('fs');
const p = 'nx.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.targetDefaults.test.dependsOn = ['^build', 'generate-feature-modules'];
j.targetDefaults.typecheck = { dependsOn: ['generate-feature-modules'] };
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"

echo "Manual: wire nestjs-pino, call loadEnv() in main.ts, add a health check."
echo "Manual: convert apps/api-e2e from Jest to Vitest, rename its target to"
echo "  an explicit 'e2e' (not the inferred 'test'), exclude it from @nx/vitest's"
echo "  auto-inference in nx.json. Tag scope:api."
read -r -p "Press enter once apps/api is wired: " _

# Smoke test: instantiates AppModule through Nest's testing module, so
# 'nx test api' exercises something real (incl. the empty featureModules
# spread) rather than zero test files.
cat > apps/api/src/app/app.module.spec.ts <<'EOF'
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module';

describe('AppModule', () => {
  it('compiles with the health check controller wired', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef).toBeDefined();

    await moduleRef.close();
  });
});
EOF

# ── Step: apps/web ────────────────────────────────────────────────────

pnpm add -D @nx/next@23.1.0
npx nx g @nx/next:app apps/web --no-interactive --unitTestRunner=vitest

pnpm --filter web add \
  @tanstack/react-query \
  class-variance-authority clsx tailwind-merge lucide-react @radix-ui/react-slot \
  tailwindcss @tailwindcss/postcss postcss

# Root test-tooling deps: jsdom (Vitest's browser-like environment for
# apps/web), the Testing Library trio (component rendering + interaction +
# jest-dom matchers), and @vitejs/plugin-react (apps/web's vitest.config.mts
# needs JSX transform, which apps/api's Vitest config never does — Nest has
# no JSX). Current stable majors as of this core's last regeneration; check
# `pnpm view <pkg> version` before reusing these pins on a future bump.
pnpm add -D \
  jsdom@^30.0.1 \
  @testing-library/react@^16.3.2 \
  @testing-library/jest-dom@^7.0.1 \
  @testing-library/user-event@^14.6.4 \
  @vitejs/plugin-react@^6.0.5

# Known issue: @nx/next:app --unitTestRunner=vitest generates a Node-flavored
# vitest.config.mts (environment: 'node', no JSX plugin, no path alias
# resolution) — wrong for a React app. Replace it with a jsdom config that
# also resolves the '@/*' -> './src/*' alias apps/web/tsconfig.json already
# declares (Vitest doesn't read tsconfig `paths` on its own).
cat > apps/web/vitest.config.mts <<'EOF'
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/web',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    name: 'web',
    watch: false,
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
EOF

cat > apps/web/src/test-setup.ts <<'EOF'
import '@testing-library/jest-dom/vitest';
EOF

# Known issue: apps/web/tsconfig.spec.json (from --unitTestRunner=vitest)
# doesn't set jsx and is missing @testing-library/jest-dom from its types
# array, and apps/web/tsconfig.json's own exclude list only drops
# src/**/*.spec.ts / *.test.ts, not the .tsx variants a React app's specs
# actually use.
node -e "
const fs = require('fs');
const p = 'apps/web/tsconfig.spec.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.compilerOptions.jsx = 'preserve';
j.compilerOptions.types = [
  'vitest/globals', 'vitest/importMeta', 'vite/client', 'node', 'vitest',
  '@testing-library/jest-dom',
];
if (!j.include.includes('src/test-setup.ts')) {
  j.include.splice(j.include.indexOf('src/**/*.test.ts'), 0, 'src/test-setup.ts');
}
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"
# Known issue: apps/web/tsconfig.json's own 'src/**/*.ts' include also
# matches src/test-setup.ts, so its composite tsc -b run tries (and fails
# with TS6305) to consume tsconfig.spec.json's build output for the same
# file — exclude it from the main config the same way *.spec.ts/*.test.ts
# already are.
node -e "
const fs = require('fs');
const p = 'apps/web/tsconfig.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.exclude.push('src/test-setup.ts', 'src/**/*.spec.tsx', 'src/**/*.test.tsx');
if (!j.references.some((r) => r.path === './tsconfig.spec.json')) {
  j.references.push({ path: './tsconfig.spec.json' });
}
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"

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
echo "  - apps/web/.env.example: NEXT_PUBLIC_API_BASE_URL, carrying apps/api's"
echo "    /api global prefix (http://localhost:3333/api). Next loads env from"
echo "    the app directory, so the root .env never reaches it. rsync excludes"
echo "    .env but NOT .env.example — an absent one deletes it."
echo "  - apps/web/src/components/theme-toggle.spec.tsx: a render + click"
echo "    smoke test for ThemeToggle (Testing Library + jest-dom matchers),"
echo "    so 'nx test web' exercises something real, not zero test files."
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
echo "=== Verification passed. Sync into src/golden-cores/full-stack-app/: ==="
echo "  rsync -a --exclude=node_modules --exclude=.git --exclude=.nx \\"
echo "    --exclude=dist --exclude=out-tsc --exclude='*.tsbuildinfo' \\"
echo "    --exclude=.env --exclude='apps/web/.next' \\"
echo "    '$SCRATCH/' '$REPO_ROOT/src/golden-cores/full-stack-app/'"
echo ""
echo "IMPORTANT: rename the synced .gitignore —"
echo "  mv '$REPO_ROOT/src/golden-cores/full-stack-app/.gitignore' '$REPO_ROOT/src/golden-cores/full-stack-app/gitignore.template'"
echo "npm strips files literally named .gitignore from published tarballs."
echo "bin/cli.mjs's DOTFILE_RENAMES restores the name on install."
echo ""
echo "Then diff against the previous src/golden-cores/full-stack-app/ and commit deliberately —"
echo "don't blind-overwrite without reviewing what changed upstream."
