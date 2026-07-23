import baseConfig from './packages/config/eslint-base.js';

/**
 * Root flat ESLint config. Extends the locked shared base from
 * `packages/config/eslint-base.js` (module boundaries, TypeScript/JS
 * rules). Every app/lib in the workspace resolves through this file —
 * don't add per-project overrides here; fix the base config at its
 * source instead.
 */
export default [
  ...baseConfig,
  {
    ignores: ['**/vitest.config.*.timestamp*', '**/test-output'],
  },
];
