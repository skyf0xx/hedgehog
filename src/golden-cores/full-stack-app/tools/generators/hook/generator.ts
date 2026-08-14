import { formatFiles, Tree } from '@nx/devkit';
import { appendBarrelExport, generateLibShell } from '../lib-shell';
import { moduleNames, ModuleNames } from '../naming';

interface HookGeneratorOptions {
  module: string;
  toggleField?: string;
}

const PACKAGE_ROOT = 'packages/hooks';

export default async function hookGenerator(
  tree: Tree,
  options: HookGeneratorOptions,
) {
  const names = moduleNames(options.module);

  await generateLibShell(tree, {
    directory: PACKAGE_ROOT,
    importName: 'hooks',
    tags: ['scope:hooks', 'type:hook'],
    dependencies: {
      '@tanstack/react-query': '^5.101.4',
      '@ts-rest/core': '3.53.0-rc.1',
      contracts: 'workspace:*',
    },
    references: ['../contracts/tsconfig.lib.json'],
  });

  writeApiBaseUrl(tree);

  const dir = `${PACKAGE_ROOT}/src/${names.module}`;
  tree.write(`${dir}/${names.module}.client.ts`, clientFile(names));
  tree.write(`${dir}/${names.module}.keys.ts`, keysFile(names));
  tree.write(
    `${dir}/use-${names.module}.ts`,
    hooksFile(names, options.toggleField),
  );
  tree.write(`${dir}/index.ts`, barrelFile(names));
  tree.write(
    `${dir}/${names.module}.spec.ts`,
    specFile(names, options.toggleField),
  );

  appendBarrelExport(tree, `${PACKAGE_ROOT}/src/index.ts`, `./${names.module}/index`);

  await formatFiles(tree);
}

/**
 * Read at call time rather than captured at module load: this package is
 * consumed as TypeScript source by both apps/web (where Next inlines
 * NEXT_PUBLIC_API_BASE_URL at build time) and Vitest (where it is absent),
 * and a module-scope read would freeze the test-time fallback into the app.
 */
function writeApiBaseUrl(tree: Tree) {
  const path = `${PACKAGE_ROOT}/src/api-base-url.ts`;
  if (tree.exists(path)) return;

  tree.write(
    path,
    `export function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3333/api';
}
`,
  );
  appendBarrelExport(tree, `${PACKAGE_ROOT}/src/index.ts`, './api-base-url');
}

function clientFile(names: ModuleNames): string {
  return `import { initClient } from '@ts-rest/core';
import { ${names.camel}Contract } from 'contracts';
import { apiBaseUrl } from '../api-base-url';

export function ${names.camel}Client() {
  return initClient(${names.camel}Contract, { baseUrl: apiBaseUrl() });
}

export type ${names.pascal}Client = ReturnType<typeof ${names.camel}Client>;
`;
}

/**
 * A factory rather than loose string arrays: every mutation below
 * invalidates through the same keys, so a rename that misses one is a
 * compile error instead of a cache that silently stops refreshing.
 */
function keysFile(names: ModuleNames): string {
  return `export const ${names.camel}Keys = {
  all: () => ['${names.module}'] as const,
  lists: () => [...${names.camel}Keys.all(), 'list'] as const,
  details: () => [...${names.camel}Keys.all(), 'detail'] as const,
  detail: (id: string) => [...${names.camel}Keys.details(), id] as const,
};
`;
}

function hooksFile(names: ModuleNames, toggleField?: string): string {
  const { camel, pascal, entityPascal } = names;

  return `import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { Create${entityPascal}, Update${entityPascal} } from 'contracts';
import { ${camel}Client, type ${pascal}Client } from './${names.module}.client';
import { ${camel}Keys } from './${names.module}.keys';

const client: ${pascal}Client = ${camel}Client();

export function use${pascal}() {
  return useQuery({
    queryKey: ${camel}Keys.lists(),
    queryFn: async () => {
      const response = await client.list();
      if (response.status !== 200) {
        throw new Error('Failed to load ${names.module}.');
      }
      return response.body;
    },
  });
}

export function use${entityPascal}(id: string) {
  return useQuery({
    queryKey: ${camel}Keys.detail(id),
    queryFn: async () => {
      const response = await client.get({ params: { id } });
      if (response.status !== 200) {
        throw new Error(\`Failed to load ${names.entityCamel} \${id}.\`);
      }
      return response.body;
    },
    enabled: id.length > 0,
  });
}

export function useCreate${entityPascal}() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: Create${entityPascal}) => {
      const response = await client.create({ body });
      if (response.status !== 201) {
        throw new Error('Failed to create the ${names.entityCamel}.');
      }
      return response.body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ${camel}Keys.lists() });
    },
  });
}

export function useUpdate${entityPascal}() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      ...body
    }: Update${entityPascal} & { id: string }) => {
      const response = await client.update({ params: { id }, body });
      if (response.status !== 200) {
        throw new Error(\`Failed to update ${names.entityCamel} \${id}.\`);
      }
      return response.body;
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ${camel}Keys.lists() });
      queryClient.invalidateQueries({
        queryKey: ${camel}Keys.detail(variables.id),
      });
    },
  });
}

export function useRemove${entityPascal}() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await client.remove({ params: { id } });
      if (response.status !== 204) {
        throw new Error(\`Failed to delete ${names.entityCamel} \${id}.\`);
      }
      return id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ${camel}Keys.lists() });
      queryClient.removeQueries({ queryKey: ${camel}Keys.detail(id) });
    },
  });
}${
    toggleField
      ? `

/**
 * Sends the id and nothing else. The server reads the current
 * ${toggleField} and flips it inside one transaction, so a stale row in
 * this cache cannot overwrite a newer state — which is what computing
 * the new value here from a cached row would do, losing one of any two
 * flips that raced.
 */
export function useToggle${entityPascal}() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await client.toggle({ params: { id } });
      if (response.status !== 200) {
        throw new Error(\`Failed to toggle ${names.entityCamel} \${id}.\`);
      }
      return response.body;
    },
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: ${camel}Keys.lists() });
      queryClient.invalidateQueries({ queryKey: ${camel}Keys.detail(id) });
    },
  });
}`
      : ''
  }
`;
}

function barrelFile(names: ModuleNames): string {
  return `export * from './${names.module}.client';
export * from './${names.module}.keys';
export * from './use-${names.module}';
`;
}

function specFile(names: ModuleNames, toggleField?: string): string {
  const { camel, entityPascal } = names;

  return `import { describe, expect, it } from 'vitest';
import { ${camel}Keys } from './${names.module}.keys';
import {
  useCreate${entityPascal},
  useRemove${entityPascal},
  useUpdate${entityPascal},
  use${names.pascal},
} from './use-${names.module}';

describe('${camel} query keys', () => {
  it('nests every key under one invalidation root', () => {
    expect(${camel}Keys.all()).toEqual(['${names.module}']);
    expect(${camel}Keys.lists()).toEqual(['${names.module}', 'list']);
    expect(${camel}Keys.detail('abc')).toEqual([
      '${names.module}',
      'detail',
      'abc',
    ]);
  });

  it('keeps a detail key inside the details prefix, so one call clears both', () => {
    const detail = ${camel}Keys.detail('abc');

    expect(detail.slice(0, 2)).toEqual(${camel}Keys.details());
  });
});

describe('${camel} hooks', () => {
  it('exposes the query and mutation set the screen layer consumes', () => {
    expect(use${names.pascal}).toBeTypeOf('function');
    expect(useCreate${entityPascal}).toBeTypeOf('function');
    expect(useUpdate${entityPascal}).toBeTypeOf('function');
    expect(useRemove${entityPascal}).toBeTypeOf('function');
  });${
    toggleField
      ? `

  it('exposes a dedicated ${toggleField} toggle', async () => {
    const { useToggle${entityPascal} } = await import('./use-${names.module}');

    expect(useToggle${entityPascal}).toBeTypeOf('function');
  });

  it('routes the toggle at a server endpoint that takes no body', async () => {
    const { ${camel}Contract } = await import('contracts');

    expect(${camel}Contract.toggle.method).toBe('POST');
    expect(String(${camel}Contract.toggle.body)).toBe('Symbol(ContractNoBody)');
  });`
      : ''
  }
});
`;
}
