import nx from '@nx/eslint-plugin';

/**
 * Locked, shared ESLint flat config — extended by every app/lib in the
 * workspace (via root `eslint.config.mjs`). Encodes Nx module boundaries
 * (tags + depConstraints) as a build-time (`nx lint`) failure. See
 * `.claude/skills/hedgehog-bootstrap` and `.claude/skills/hedgehog-loop`
 * for the discipline this enforces.
 *
 * The constraints below describe the project shape `core.yaml`'s compiled
 * layer sequence actually produces. One layer, `repository`, lands a
 * module's port interface AND its Drizzle adapter in the same lib
 * (`libs/<module>/repository`, tagged `type:adapter`) — there is no
 * separate `type:port` project, so a tag constraint alone cannot say
 * "import the interface, not the concrete class." The
 * `no-restricted-imports` block below carries that half of port
 * discipline; the tag graph carries the rest.
 *
 * Tag reference:
 *   apps/api             -> scope:api
 *   apps/worker           -> scope:worker
 *   apps/web              -> scope:web
 *   apps/mobile           -> scope:mobile
 *   packages/db           -> scope:db,        type:adapter
 *   packages/contracts    -> scope:contracts, type:contract
 *   packages/hooks        -> scope:hooks,     type:hook
 *   packages/auth         -> scope:auth,      type:adapter
 *   packages/config       -> scope:config,    type:util
 *   packages/shared       -> scope:shared,    type:util
 *   libs/<module>/repository -> scope:<module>, type:adapter
 *   libs/<module>/service    -> scope:<module>, type:service
 */
export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc'],
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          // `false`, not `true`: `packages/contracts` and `packages/hooks`
          // are source-only by this core's design — they have no `build`
          // target and are consumed as TypeScript sources. With this on,
          // `apps/web` (a real Next build target) importing either one
          // fails lint purely for that structural choice, not for any
          // dependency that's actually wrong.
          enforceBuildableLibDependency: false,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            // domain services reach storage through their own module's
            // repository lib, which holds the port interface alongside the
            // Drizzle adapter (`type:adapter`). Which symbol a service may
            // import out of that lib is the no-restricted-imports rule
            // below, not something a tag can express.
            {
              sourceTag: 'type:service',
              onlyDependOnLibsWithTags: [
                'type:adapter',
                'type:contract',
                'type:util',
              ],
            },
            // adapters (repositories, db client, auth config) depend on
            // packages/db and shared utils — never reach across into
            // another module's service
            {
              sourceTag: 'type:adapter',
              onlyDependOnLibsWithTags: [
                'type:adapter',
                'type:contract',
                'type:util',
              ],
            },
            // the ts-rest/Zod contract is derived from the Drizzle schema
            // (`drizzle-zod`), so it reaches packages/db and nothing else
            {
              sourceTag: 'type:contract',
              onlyDependOnLibsWithTags: ['type:adapter', 'type:util'],
            },
            // TanStack Query hooks are typed by the contract they call
            {
              sourceTag: 'type:hook',
              onlyDependOnLibsWithTags: ['type:contract', 'type:util'],
            },
            // shared utils (packages/config, packages/shared) depend on
            // nothing else in the workspace — they're the floor
            {
              sourceTag: 'type:util',
              onlyDependOnLibsWithTags: ['type:util'],
            },
            // web/mobile never import db or api internals — only contracts +
            // hooks (+ shared util packages like packages/config, same as
            // every other app in the workspace)
            {
              sourceTag: 'scope:web',
              onlyDependOnLibsWithTags: [
                'scope:contracts',
                'scope:hooks',
                'scope:shared',
                'type:util',
              ],
            },
            {
              sourceTag: 'scope:mobile',
              onlyDependOnLibsWithTags: [
                'scope:contracts',
                'scope:hooks',
                'scope:shared',
                'type:util',
              ],
            },
            // worker reaches domain logic the same way api does
            {
              sourceTag: 'scope:worker',
              onlyDependOnLibsWithTags: [
                'type:adapter',
                'type:service',
                'type:contract',
                'type:util',
                'scope:shared',
              ],
            },
            // api is the composition root: its NestJS module is the only
            // place that constructs a module's concrete adapter and binds
            // it to the port's DI token, so it reaches `type:adapter` by
            // necessity. It also serves the ts-rest contract, hence
            // `type:contract`. What it may NOT do is inject an adapter
            // into a controller — that's the no-restricted-imports rule.
            {
              sourceTag: 'scope:api',
              onlyDependOnLibsWithTags: [
                'type:adapter',
                'type:service',
                'type:contract',
                'type:util',
              ],
            },
          ],
        },
      ],
    },
  },
  {
    // Port discipline, the half tags can't express. A module's port
    // interface and its Drizzle adapter live in the same lib, so
    // `type:service -> type:adapter` has to be allowed above; this is what
    // stops a service from importing the concrete adapter through it.
    // Services see the port only. Deep paths are named rather than the
    // package entry point, because the entry point is also how the port
    // itself is imported.
    files: ['libs/*/service/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/*.adapter', '**/*.adapter.js', '**/*.adapter.ts'],
              message:
                'A service depends on its module\'s port interface, never the concrete adapter. Import the port from the repository lib\'s entry point and let apps/api bind the adapter to its DI token.',
            },
            {
              group: ['@app/db', '@app/db/*', 'db', 'db/*', 'drizzle-orm', 'drizzle-orm/*'],
              message:
                'A service never talks to the database directly — that is the repository adapter\'s job, reached through the port.',
            },
          ],
        },
      ],
    },
  },
  {
    // The same rule one layer up, minus the composition root. A NestJS
    // module file (`*.module.ts`) is where the adapter is constructed and
    // bound, so it is exempt; a controller injecting an adapter is not.
    files: ['apps/api/**/*.ts'],
    ignores: ['apps/api/**/*.module.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/*.adapter', '**/*.adapter.js', '**/*.adapter.ts'],
              message:
                'Only a NestJS module (*.module.ts) constructs a concrete adapter. A controller depends on the service, or on the port token the module bound.',
            },
          ],
        },
      ],
    },
  },
];
