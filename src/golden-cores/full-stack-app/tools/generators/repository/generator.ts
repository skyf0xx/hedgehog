import { formatFiles, Tree } from '@nx/devkit';
import { generateLibShell } from '../lib-shell';
import { moduleNames, ModuleNames } from '../naming';

interface RepositoryGeneratorOptions {
  module: string;
}

export default async function repositoryGenerator(
  tree: Tree,
  options: RepositoryGeneratorOptions,
) {
  const names = moduleNames(options.module);
  const root = `libs/${names.module}/repository`;

  await generateLibShell(tree, {
    directory: root,
    importName: `${names.module}-repository`,
    // The pair packages/config/eslint-base.js's depConstraints expect for a
    // repository lib: it holds the port interface and its Drizzle adapter
    // in one project, so `type:adapter` is what a service is allowed to
    // depend on; the no-restricted-imports rule is what stops the service
    // from reaching the adapter through it.
    tags: [`scope:${names.module}`, 'type:adapter'],
    dependencies: { db: 'workspace:*' },
    references: ['../../../packages/db/tsconfig.lib.json'],
  });

  tree.write(`${root}/src/lib/${names.entityKebab}.port.ts`, portFile(names));
  tree.write(
    `${root}/src/lib/${names.entityKebab}.adapter.ts`,
    adapterFile(names),
  );
  tree.write(
    `${root}/src/lib/${names.entityKebab}.adapter.spec.ts`,
    adapterSpecFile(names),
  );
  tree.write(`${root}/src/index.ts`, barrelFile(names));

  await formatFiles(tree);
}

/**
 * The port is the only symbol a service may see, so the DI token lives
 * beside it rather than in the adapter file — importing the token out of
 * `*.adapter.ts` would drag the concrete class across the boundary
 * eslint-base.js's no-restricted-imports rule draws.
 */
function portFile(names: ModuleNames): string {
  const { entityPascal, entityConstant } = names;

  return `import type { ${entityPascal}, New${entityPascal} } from 'db';

// Re-exported so a service can name the entity type without importing
// packages/db itself — eslint-base.js's no-restricted-imports rule bans a
// service from reaching the database package at all, type-only or not.
export type { ${entityPascal} };

export type ${entityPascal}Draft = Omit<
  New${entityPascal},
  'id' | 'createdAt' | 'updatedAt'
>;
export type ${entityPascal}Patch = Partial<${entityPascal}Draft>;

export interface ${entityPascal}Repository {
  findAll(): Promise<${entityPascal}[]>;
  /** A miss is a plain absence — the service decides what it means. */
  findById(id: string): Promise<${entityPascal} | undefined>;
  create(draft: ${entityPascal}Draft): Promise<${entityPascal}>;
  update(id: string, patch: ${entityPascal}Patch): Promise<${entityPascal} | undefined>;
  remove(id: string): Promise<boolean>;
  /**
   * Runs \`work\` inside one database transaction, handing it a repository
   * bound to that transaction. A throw rolls every write back, which is how
   * a multi-write service method stays all-or-nothing without the service
   * itself knowing about Drizzle.
   */
  transaction<T>(
    work: (repository: ${entityPascal}Repository) => Promise<T>,
  ): Promise<T>;
}

export const ${entityConstant}_REPOSITORY = Symbol('${entityPascal}Repository');
`;
}

function adapterFile(names: ModuleNames): string {
  const { entityPascal, camel } = names;

  return `import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ${camel}, type ${entityPascal} } from 'db';
import type {
  ${entityPascal}Draft,
  ${entityPascal}Patch,
  ${entityPascal}Repository,
} from './${names.entityKebab}.port';

/**
 * Takes a thunk rather than a database instance so that constructing the
 * adapter — which apps/api's module does at DI-container build time —
 * opens no connection. getDb() reads DATABASE_URL and exits the process
 * when it is absent, which would make merely compiling AppModule in a test
 * require a live Postgres.
 */
export class Drizzle${entityPascal}Repository implements ${entityPascal}Repository {
  constructor(private readonly db: () => NodePgDatabase) {}

  async findAll(): Promise<${entityPascal}[]> {
    return this.db().select().from(${camel});
  }

  async findById(id: string): Promise<${entityPascal} | undefined> {
    const [row] = await this.db()
      .select()
      .from(${camel})
      .where(eq(${camel}.id, id))
      .limit(1);
    return row;
  }

  async create(draft: ${entityPascal}Draft): Promise<${entityPascal}> {
    const [row] = await this.db().insert(${camel}).values(draft).returning();
    return row;
  }

  async update(
    id: string,
    patch: ${entityPascal}Patch,
  ): Promise<${entityPascal} | undefined> {
    const [row] = await this.db()
      .update(${camel})
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(${camel}.id, id))
      .returning();
    return row;
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.db()
      .delete(${camel})
      .where(eq(${camel}.id, id))
      .returning({ id: ${camel}.id });
    return rows.length > 0;
  }

  async transaction<T>(
    work: (repository: ${entityPascal}Repository) => Promise<T>,
  ): Promise<T> {
    return this.db().transaction((tx) =>
      work(new Drizzle${entityPascal}Repository(() => tx)),
    );
  }
}
`;
}

/**
 * The adapter's contract with Drizzle, proved against an in-memory double
 * rather than a live Postgres: the rollback assertion is what a service's
 * multi-write transaction depends on, and `nx test` has no database.
 */
function adapterSpecFile(names: ModuleNames): string {
  const { entityPascal } = names;

  return `import { describe, expect, it, vi } from 'vitest';
import { Drizzle${entityPascal}Repository } from './${names.entityKebab}.adapter';

interface FakeRow {
  id: string;
}

/**
 * A Drizzle stand-in, not a live database — nx test has no Postgres. It
 * models exactly the two behaviours the port promises and the service
 * layer relies on: a miss is an empty result set, and a throw inside
 * transaction restores the pre-transaction rows.
 */
function fakeDb(rows: FakeRow[]) {
  let staged = [...rows];
  let nextId = 0;

  const select = () => ({
    from: () => {
      const all = Promise.resolve(staged);
      return Object.assign(all, {
        where: () => ({ limit: () => Promise.resolve(staged.slice(0, 1)) }),
      });
    },
  });

  const insert = () => ({
    values: (draft: Record<string, unknown>) => ({
      returning: () => {
        const row: FakeRow = { ...draft, id: \`generated-\${(nextId += 1)}\` };
        staged = [...staged, row];
        return Promise.resolve([row]);
      },
    }),
  });

  const update = () => ({
    set: (patch: Record<string, unknown>) => ({
      where: () => ({
        returning: () =>
          Promise.resolve(staged.length ? [{ ...staged[0], ...patch }] : []),
      }),
    }),
  });

  const remove = () => ({
    where: () => ({
      returning: () => {
        const removed = staged.slice(0, 1);
        staged = staged.slice(1);
        return Promise.resolve(removed);
      },
    }),
  });

  async function transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    const snapshot = [...staged];
    try {
      return await work(db);
    } catch (error) {
      staged = snapshot;
      throw error;
    }
  }

  const db = { select, insert, update, delete: remove, transaction };

  return {
    db,
    get rows(): FakeRow[] {
      return staged;
    },
  };
}

describe('Drizzle${entityPascal}Repository', () => {
  it('returns undefined rather than throwing when a row is absent', async () => {
    const fake = fakeDb([]);
    const repository = new Drizzle${entityPascal}Repository(
      () => fake.db as never,
    );

    await expect(repository.findById('missing')).resolves.toBeUndefined();
  });

  it('reports a delete that matched nothing as false', async () => {
    const fake = fakeDb([]);
    const repository = new Drizzle${entityPascal}Repository(
      () => fake.db as never,
    );

    await expect(repository.remove('missing')).resolves.toBe(false);
  });

  it('rolls every write back when the transaction body throws', async () => {
    const fake = fakeDb([{ id: 'existing' }]);
    const repository = new Drizzle${entityPascal}Repository(
      () => fake.db as never,
    );
    const boom = new Error('second write failed');

    await expect(
      repository.transaction(async (tx) => {
        await tx.create({} as never);
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(fake.rows).toHaveLength(1);
  });

  it('hands the transaction body a repository bound to that transaction', async () => {
    const fake = fakeDb([{ id: 'existing' }]);
    const repository = new Drizzle${entityPascal}Repository(
      () => fake.db as never,
    );
    const seen = vi.fn();

    await repository.transaction(async (tx) => {
      seen(tx instanceof Drizzle${entityPascal}Repository);
    });

    expect(seen).toHaveBeenCalledWith(true);
  });
});
`;
}

function barrelFile(names: ModuleNames): string {
  return `export * from './lib/${names.entityKebab}.adapter';
export * from './lib/${names.entityKebab}.port';
`;
}
