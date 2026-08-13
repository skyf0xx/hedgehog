import { formatFiles, Tree } from '@nx/devkit';
import {
  drizzleColumn,
  drizzleImports,
  Field,
  isDateField,
  parseFields,
} from '../fields';
import { moduleNames, ModuleNames } from '../naming';

interface SchemaGeneratorOptions {
  module: string;
  fields: string;
}

export default async function schemaGenerator(
  tree: Tree,
  options: SchemaGeneratorOptions,
) {
  const names = moduleNames(options.module);
  const fields = parseFields(options.fields);
  const dir = `packages/db/src/schema/${names.module}`;

  tree.write(`${dir}/${names.module}.table.ts`, tableFile(names, fields));
  tree.write(`${dir}/${names.module}.zod.ts`, zodFile(names));
  tree.write(`${dir}/index.ts`, barrelFile(names));
  tree.write(`${dir}/${names.module}.spec.ts`, specFile(names, fields));

  addSchemaBarrelExport(tree, names.module);

  await formatFiles(tree);
}

function tableFile(names: ModuleNames, fields: Field[]): string {
  const imports = drizzleImports(fields).join(', ');
  const columns = fields.map((field) => `  ${drizzleColumn(field)}`).join('\n');

  return `import { ${imports} } from 'drizzle-orm/pg-core';

export const ${names.camel} = pgTable('${names.tableName}', {
  id: uuid('id').primaryKey().defaultRandom(),
${columns}
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ${names.entityPascal} = typeof ${names.camel}.$inferSelect;
export type New${names.entityPascal} = typeof ${names.camel}.$inferInsert;
`;
}

function zodFile(names: ModuleNames): string {
  return `import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from 'drizzle-zod';
import { ${names.camel} } from './${names.module}.table';

export const select${names.entityPascal}Schema = createSelectSchema(${names.camel});
export const insert${names.entityPascal}Schema = createInsertSchema(${names.camel});
export const update${names.entityPascal}Schema = createUpdateSchema(${names.camel});
`;
}

function barrelFile(names: ModuleNames): string {
  return `export * from './${names.module}.table';
export * from './${names.module}.zod';
`;
}

function specFile(names: ModuleNames, fields: Field[]): string {
  const columnAssertions = ['id', ...fields.map((field) => field.name)]
    .map((name) => `    expect(columns).toContain('${name}');`)
    .join('\n');
  const dateField = fields.find(isDateField);

  return `import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  ${names.camel},
  insert${names.entityPascal}Schema,
  select${names.entityPascal}Schema,
} from './index';

describe('${names.camel} schema', () => {
  it('maps to the ${names.tableName} table with every declared column', () => {
    const columns = Object.keys(getTableColumns(${names.camel}));

    expect(getTableName(${names.camel})).toBe('${names.tableName}');
${columnAssertions}
    expect(columns).toContain('createdAt');
    expect(columns).toContain('updatedAt');
  });

  it('derives a select schema that accepts a full row', () => {
    const parsed = select${names.entityPascal}Schema.parse(${rowLiteral(names, fields)});

    expect(parsed.id).toBe('${SAMPLE_UUID}');
  });

  it('derives an insert schema that rejects a row missing a required column', () => {
    const result = insert${names.entityPascal}Schema.safeParse({});

    expect(result.success).toBe(${fields.every((field) => field.nullable) ? 'true' : 'false'});
  });${
    dateField
      ? `

  it('reflects a timestamp column as a Date on the server side', () => {
    const parsed = select${names.entityPascal}Schema.parse(${rowLiteral(names, fields)});

    expect(parsed.${dateField.name}).toBeInstanceOf(Date);
  });`
      : ''
  }
});
`;
}

const SAMPLE_UUID = '00000000-0000-4000-8000-000000000000';

function rowLiteral(names: ModuleNames, fields: Field[]): string {
  const entries = [
    `id: '${SAMPLE_UUID}'`,
    ...fields.map((field) => `${field.name}: ${sampleValue(field)}`),
    'createdAt: new Date()',
    'updatedAt: new Date()',
  ];
  return `{\n      ${entries.join(',\n      ')},\n    }`;
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

/**
 * `packages/db/src/schema/index.ts` is a barrel-of-barrels every module's
 * schema layer appends one line to (in scope — see core.yaml). Its shipped
 * body is `export {};`, which is dropped once a real export exists.
 */
function addSchemaBarrelExport(tree: Tree, module: string) {
  const barrelPath = 'packages/db/src/schema/index.ts';
  const current = tree.read(barrelPath, 'utf-8') ?? '';
  const line = `export * from './${module}/index';`;
  if (current.includes(line)) return;

  const lines = current
    .split('\n')
    .filter((entry) => entry.trim() !== 'export {};');
  const exportLines = lines
    .filter((entry) => entry.startsWith('export * from'))
    .concat(line)
    .sort();
  const header = lines.filter((entry) => entry.startsWith('//'));

  tree.write(barrelPath, `${[...header, '', ...exportLines].join('\n')}\n`);
}
