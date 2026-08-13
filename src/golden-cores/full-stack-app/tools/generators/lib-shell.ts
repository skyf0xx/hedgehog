import { libraryGenerator } from '@nx/js';
import { joinPathFragments, Tree, updateJson } from '@nx/devkit';

/**
 * The `@nx/js:lib` call every first-arrival layer makes, plus the
 * corrections this workspace's conventions need on top of the generator's
 * defaults. Owned here so `contract`, `repository`, `service`, and `hook`
 * cannot drift on the shell they land.
 *
 * Two of those corrections are load-bearing:
 *
 * - `@nx/js:lib` writes `module`/`moduleResolution: "nodenext"` into the
 *   generated tsconfigs and a `.js` extension onto the barrel's own
 *   relative import. Turbopack cannot resolve a nodenext-style `.js`
 *   specifier across a pnpm workspace-package boundary, which is why
 *   `tsconfig.base.json` pins esnext/bundler — a per-package nodenext
 *   override reintroduces exactly that break for anything `apps/web`
 *   imports.
 * - The generated `package.json` carries no `nx.tags`, and
 *   `packages/config/eslint-base.js`'s `depConstraints` are keyed
 *   entirely on tags: an untagged project satisfies no constraint and
 *   fails `@nx/enforce-module-boundaries` on its first workspace import.
 */
export interface LibShellOptions {
  directory: string;
  importName: string;
  tags: string[];
  dependencies?: Record<string, string>;
  /** tsconfig.lib.json project references, as paths relative to the lib. */
  references?: string[];
}

export async function generateLibShell(tree: Tree, options: LibShellOptions) {
  if (tree.exists(joinPathFragments(options.directory, 'package.json'))) {
    applyShellConventions(tree, options);
    return;
  }

  await libraryGenerator(tree, {
    directory: options.directory,
    name: options.importName,
    bundler: 'none',
    unitTestRunner: 'vitest',
    // `linter: 'eslint'` would land a per-package eslint.config.mjs and a
    // project.json whose empty `tags: []` takes precedence over the
    // package.json tags below — silently emptying the tag set every
    // depConstraint in packages/config/eslint-base.js keys on. The root
    // eslint.config.mjs already covers every project in the workspace.
    linter: 'none',
    skipFormat: true,
  });

  // The generator's placeholder lib + README carry no domain content and
  // are replaced wholesale by the layer's own files.
  for (const placeholder of [
    `${options.directory}/src/lib/${options.importName}.ts`,
    `${options.directory}/src/lib/${options.importName}.spec.ts`,
    `${options.directory}/README.md`,
    `${options.directory}/project.json`,
    `${options.directory}/eslint.config.mjs`,
  ]) {
    if (tree.exists(placeholder)) tree.delete(placeholder);
  }

  applyShellConventions(tree, options);
}

function applyShellConventions(tree: Tree, options: LibShellOptions) {
  updateJson(
    tree,
    joinPathFragments(options.directory, 'package.json'),
    (json) => {
      json.nx = { ...(json.nx ?? {}), tags: options.tags };
      if (options.dependencies) {
        json.dependencies = { ...(json.dependencies ?? {}), ...options.dependencies };
      }
      return json;
    },
  );

  for (const config of ['tsconfig.lib.json', 'tsconfig.spec.json']) {
    const path = joinPathFragments(options.directory, config);
    if (!tree.exists(path)) continue;
    updateJson(tree, path, (json) => {
      delete json.compilerOptions?.module;
      delete json.compilerOptions?.moduleResolution;
      return json;
    });
  }

  if (options.references?.length) {
    const path = joinPathFragments(options.directory, 'tsconfig.lib.json');
    updateJson(tree, path, (json) => {
      const existing: { path: string }[] = json.references ?? [];
      for (const reference of options.references ?? []) {
        if (!existing.some((entry) => entry.path === reference)) {
          existing.push({ path: reference });
        }
      }
      json.references = existing;
      return json;
    });
  }
}

/**
 * A barrel line free of the `.js` extension `@nx/js:lib`'s own barrel uses
 * (see the nodenext note above).
 */
export function appendBarrelExport(tree: Tree, barrelPath: string, target: string) {
  const line = `export * from '${target}';`;
  const current = tree.read(barrelPath, 'utf-8') ?? '';
  if (current.includes(line)) return;

  const lines = current
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== 'export {};')
    // The generator's own placeholder barrel line points at a lib file
    // this shell deleted.
    .filter((entry) => !/^export \* from '\.\/lib\//.test(entry));

  tree.write(barrelPath, `${[...lines, line].sort().join('\n')}\n`);
}
