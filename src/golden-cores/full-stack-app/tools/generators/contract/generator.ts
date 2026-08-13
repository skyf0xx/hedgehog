import { formatFiles, Tree } from '@nx/devkit';
import { Field, isDateField, parseFields, zodSchema } from '../fields';
import { appendBarrelExport, generateLibShell } from '../lib-shell';
import { moduleNames, ModuleNames } from '../naming';

interface ContractGeneratorOptions {
  module: string;
  fields: string;
}

const PACKAGE_ROOT = 'packages/contracts';

export default async function contractGenerator(
  tree: Tree,
  options: ContractGeneratorOptions,
) {
  const names = moduleNames(options.module);
  const fields = parseFields(options.fields);

  await generateLibShell(tree, {
    directory: PACKAGE_ROOT,
    importName: 'contracts',
    tags: ['scope:contracts', 'type:contract'],
    dependencies: {
      '@ts-rest/core': '3.53.0-rc.1',
      zod: '^4.4.3',
    },
  });

  writeTimestampSchema(tree);

  const dir = `${PACKAGE_ROOT}/src/${names.module}`;
  tree.write(`${dir}/${names.module}.schema.ts`, entitySchemaFile(names, fields));
  tree.write(`${dir}/${names.module}.errors.ts`, errorSchemaFile(names));
  tree.write(`${dir}/${names.module}.contract.ts`, contractFile(names));
  tree.write(`${dir}/index.ts`, barrelFile(names));
  tree.write(`${dir}/${names.module}.spec.ts`, specFile(names, fields));

  appendBarrelExport(tree, `${PACKAGE_ROOT}/src/index.ts`, `./${names.module}/index`);

  await formatFiles(tree);
}

/**
 * The shared half of the date-mode rule: a `timestamp` column declared
 * `mode: 'date'` reflects through `createSelectSchema` as `z.date()`, which
 * the server satisfies with a real `Date` and the browser never can — JSON
 * carries it as an ISO string. Neither side alone is right, and no
 * `.transform()` satisfies both, so the contract accepts the union.
 */
function writeTimestampSchema(tree: Tree) {
  const path = `${PACKAGE_ROOT}/src/timestamp.ts`;
  if (tree.exists(path)) return;

  tree.write(
    path,
    `import { z } from 'zod';

export const timestampSchema = z.union([z.date(), z.iso.datetime()]);

export type Timestamp = z.infer<typeof timestampSchema>;
`,
  );
  appendBarrelExport(tree, `${PACKAGE_ROOT}/src/index.ts`, './timestamp');
}

function entitySchemaFile(names: ModuleNames, fields: Field[]): string {
  const bodyFields = fields
    .map((field) => `  ${field.name}: ${zodSchema(field)},`)
    .join('\n');
  const createFields = fields
    .map(
      (field) =>
        `  ${field.name}: ${zodSchema(field)}${field.nullable ? '.optional()' : ''},`,
    )
    .join('\n');

  return `import { z } from 'zod';
import { timestampSchema } from '../timestamp';

export const ${names.entityCamel}Schema = z.object({
  id: z.uuid(),
${bodyFields}
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const create${names.entityPascal}Schema = z.object({
${createFields}
});

export const update${names.entityPascal}Schema = create${names.entityPascal}Schema.partial();

export type ${names.entityPascal} = z.infer<typeof ${names.entityCamel}Schema>;
export type Create${names.entityPascal} = z.infer<typeof create${names.entityPascal}Schema>;
export type Update${names.entityPascal} = z.infer<typeof update${names.entityPascal}Schema>;
`;
}

function errorSchemaFile(names: ModuleNames): string {
  return `import { z } from 'zod';

export const ${names.entityCamel}NotFoundSchema = z.object({
  error: z.literal('${names.entityPascal}NotFound'),
  message: z.string(),
});

export const ${names.entityCamel}BadRequestSchema = z.object({
  error: z.literal('${names.entityPascal}BadRequest'),
  message: z.string(),
});

export type ${names.entityPascal}NotFound = z.infer<typeof ${names.entityCamel}NotFoundSchema>;
export type ${names.entityPascal}BadRequest = z.infer<typeof ${names.entityCamel}BadRequestSchema>;
`;
}

function contractFile(names: ModuleNames): string {
  return `import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  ${names.entityCamel}Schema,
  create${names.entityPascal}Schema,
  update${names.entityPascal}Schema,
} from './${names.module}.schema';
import {
  ${names.entityCamel}BadRequestSchema,
  ${names.entityCamel}NotFoundSchema,
} from './${names.module}.errors';

const c = initContract();

export const ${names.camel}Contract = c.router(
  {
    list: {
      method: 'GET',
      path: '/${names.module}',
      responses: {
        200: z.array(${names.entityCamel}Schema),
      },
      summary: 'List every ${names.entityCamel}',
    },
    get: {
      method: 'GET',
      path: '/${names.module}/:id',
      pathParams: z.object({ id: z.uuid() }),
      responses: {
        200: ${names.entityCamel}Schema,
        404: ${names.entityCamel}NotFoundSchema,
      },
      summary: 'Fetch one ${names.entityCamel} by id',
    },
    create: {
      method: 'POST',
      path: '/${names.module}',
      body: create${names.entityPascal}Schema,
      responses: {
        201: ${names.entityCamel}Schema,
        400: ${names.entityCamel}BadRequestSchema,
      },
      summary: 'Create a ${names.entityCamel}',
    },
    update: {
      method: 'PATCH',
      path: '/${names.module}/:id',
      pathParams: z.object({ id: z.uuid() }),
      body: update${names.entityPascal}Schema,
      responses: {
        200: ${names.entityCamel}Schema,
        400: ${names.entityCamel}BadRequestSchema,
        404: ${names.entityCamel}NotFoundSchema,
      },
      summary: 'Update a ${names.entityCamel}',
    },
    remove: {
      method: 'DELETE',
      path: '/${names.module}/:id',
      pathParams: z.object({ id: z.uuid() }),
      responses: {
        204: c.noBody(),
        404: ${names.entityCamel}NotFoundSchema,
      },
      summary: 'Delete a ${names.entityCamel}',
    },
  },
  {
    // apps/api sets /api as a global prefix at runtime (apps/api/src/main.ts),
    // so the paths above stay prefix-free and the client adds the base URL.
    strictStatusCodes: true,
  },
);
`;
}

function barrelFile(names: ModuleNames): string {
  return `export * from './${names.module}.contract';
export * from './${names.module}.errors';
export * from './${names.module}.schema';
`;
}

function specFile(names: ModuleNames, fields: Field[]): string {
  const dateField = fields.find(isDateField);
  const requiredField = fields.find((field) => !field.nullable);

  return `import { describe, expect, it } from 'vitest';
import {
  ${names.camel}Contract,
  ${names.entityCamel}Schema,
  create${names.entityPascal}Schema,
} from './index';

const sample = ${sampleLiteral(names, fields)};

describe('${names.camel} contract', () => {
  it('exposes the full CRUD route set under /${names.module}', () => {
    expect(${names.camel}Contract.list.method).toBe('GET');
    expect(${names.camel}Contract.list.path).toBe('/${names.module}');
    expect(${names.camel}Contract.get.path).toBe('/${names.module}/:id');
    expect(${names.camel}Contract.create.method).toBe('POST');
    expect(${names.camel}Contract.update.method).toBe('PATCH');
    expect(${names.camel}Contract.remove.method).toBe('DELETE');
  });

  it('accepts a server-side row, where every timestamp is a Date', () => {
    expect(${names.entityCamel}Schema.parse(sample)).toBeDefined();
  });

  it('accepts the same row as JSON, where every timestamp is an ISO string', () => {
    const overTheWire = {
      ...sample,${dateField ? `\n      ${dateField.name}: sample.${dateField.name}.toISOString(),` : ''}
      createdAt: sample.createdAt.toISOString(),
      updatedAt: sample.updatedAt.toISOString(),
    };

    expect(${names.entityCamel}Schema.parse(overTheWire)).toBeDefined();
  });
${
  requiredField
    ? `
  it('rejects a create body missing ${requiredField.name}', () => {
    const rest = { ...createInput } as Partial<typeof createInput>;
    delete rest.${requiredField.name};

    expect(create${names.entityPascal}Schema.safeParse(rest).success).toBe(false);
  });
`
    : ''
}});

const createInput = ${createLiteral(fields)};
`;
}

const SAMPLE_UUID = '00000000-0000-4000-8000-000000000000';

function sampleLiteral(names: ModuleNames, fields: Field[]): string {
  const entries = [
    `id: '${SAMPLE_UUID}'`,
    ...fields.map((field) => `${field.name}: ${sampleValue(field)}`),
    'createdAt: new Date()',
    'updatedAt: new Date()',
  ];
  return `{\n  ${entries.join(',\n  ')},\n}`;
}

function createLiteral(fields: Field[]): string {
  const entries = fields
    .filter((field) => !field.nullable)
    .map((field) => `${field.name}: ${sampleValue(field)}`);
  return `{\n  ${entries.join(',\n  ')},\n}`;
}

function sampleValue(field: Field): string {
  const byType: Record<string, string> = {
    string: `'sample'`,
    text: `'sample'`,
    boolean: 'false',
    integer: '1',
    timestamp: 'new Date()',
  };
  return byType[field.type] ?? 'null';
}
