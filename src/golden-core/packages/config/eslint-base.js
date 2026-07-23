import nx from '@nx/eslint-plugin';

/**
 * Locked, shared ESLint flat config — extended by every app/lib in the
 * workspace (via root `eslint.config.mjs`). Encodes Nx module boundaries
 * (tags + depConstraints) as a build-time (`nx lint`) failure. See
 * `.claude/skills/hedgehog-bootstrap` and `.claude/skills/hedgehog-loop`
 * for the discipline this enforces.
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
 *   libs/<module>/port       -> scope:<module>, type:port
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
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            // domain services never import adapters directly — only ports
            {
              sourceTag: 'type:service',
              onlyDependOnLibsWithTags: ['type:port', 'type:util'],
            },
            // adapters (repositories, db client, auth config) may depend on
            // shared utils only — never reach across into another module's
            // service/port
            {
              sourceTag: 'type:adapter',
              onlyDependOnLibsWithTags: ['type:util'],
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
              ],
            },
            // worker only reaches domain logic through ports, same as api
            {
              sourceTag: 'scope:worker',
              onlyDependOnLibsWithTags: [
                'type:port',
                'type:util',
                'scope:shared',
              ],
            },
            // api reaches storage/domain logic through a module's port/service
            // only — never packages/db directly
            {
              sourceTag: 'scope:api',
              onlyDependOnLibsWithTags: [
                'type:port',
                'type:service',
                'type:util',
              ],
            },
          ],
        },
      ],
    },
  },
];
