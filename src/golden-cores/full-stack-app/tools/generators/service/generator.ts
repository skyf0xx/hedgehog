import { formatFiles, Tree } from '@nx/devkit';
import { generateLibShell } from '../lib-shell';
import { moduleNames, ModuleNames } from '../naming';

interface ServiceGeneratorOptions {
  module: string;
  toggleField?: string;
}

export default async function serviceGenerator(
  tree: Tree,
  options: ServiceGeneratorOptions,
) {
  const names = moduleNames(options.module);
  const root = `libs/${names.module}/service`;

  await generateLibShell(tree, {
    directory: root,
    importName: `${names.module}-service`,
    tags: [`scope:${names.module}`, 'type:service'],
    dependencies: { [`${names.module}-repository`]: 'workspace:*' },
    references: ['../repository/tsconfig.lib.json'],
  });

  tree.write(`${root}/src/lib/${names.entityKebab}.errors.ts`, errorsFile(names));
  tree.write(
    `${root}/src/lib/${names.entityKebab}.service.ts`,
    serviceFile(names, options.toggleField),
  );
  tree.write(
    `${root}/src/lib/${names.entityKebab}.service.spec.ts`,
    serviceSpecFile(names, options.toggleField),
  );
  tree.write(`${root}/src/index.ts`, barrelFile(names));

  await formatFiles(tree);
}

/**
 * A distinct `name` on each error is what the controller layer switches on
 * to pick a status code — `instanceof` alone does not survive the class
 * identity being duplicated across a bundling boundary.
 */
function errorsFile(names: ModuleNames): string {
  const { entityPascal, entityCamel } = names;

  return `export class ${entityPascal}NotFoundError extends Error {
  override readonly name = '${entityPascal}NotFoundError';

  constructor(readonly id: string) {
    super(\`No ${entityCamel} exists with id \${id}.\`);
  }
}

export class ${entityPascal}InvalidStateError extends Error {
  override readonly name = '${entityPascal}InvalidStateError';

  constructor(message: string) {
    super(message);
  }
}
`;
}

/**
 * The flip is computed from the row this transaction just read, never
 * from a value the caller supplied: the client has no way to send a
 * stale one, so two toggles racing against each other serialize into two
 * flips instead of both writing the same value and losing one.
 */
function toggleMethod(names: ModuleNames, toggleField: string): string {
  const { entityPascal, entityCamel } = names;

  return `

  async toggle${entityPascal}(id: string): Promise<${entityPascal}> {
    return this.${entityCamel}s.transaction(async (repository) => {
      const existing = await repository.findById(id);
      if (!existing) {
        throw new ${entityPascal}NotFoundError(id);
      }
      const updated = await repository.update(id, {
        ${toggleField}: !existing.${toggleField},
      } as ${entityPascal}Patch);
      if (!updated) {
        throw new ${entityPascal}NotFoundError(id);
      }
      return updated;
    });
  }`;
}

function serviceFile(names: ModuleNames, toggleField?: string): string {
  const { entityPascal, entityCamel, entityKebab, module } = names;

  return `import type {
  ${entityPascal},
  ${entityPascal}Draft,
  ${entityPascal}Patch,
  ${entityPascal}Repository,
} from '${module}-repository';
import { ${entityPascal}NotFoundError } from './${entityKebab}.errors';

/**
 * Domain logic only — the ts-rest contract has already validated every
 * input by the time a method here runs, so nothing re-parses.
 */
export class ${entityPascal}Service {
  constructor(private readonly ${entityCamel}s: ${entityPascal}Repository) {}

  async list(): Promise<${entityPascal}[]> {
    return this.${entityCamel}s.findAll();
  }

  async getById(id: string): Promise<${entityPascal}> {
    const ${entityCamel} = await this.${entityCamel}s.findById(id);
    if (!${entityCamel}) {
      throw new ${entityPascal}NotFoundError(id);
    }
    return ${entityCamel};
  }

  async create(draft: ${entityPascal}Draft): Promise<${entityPascal}> {
    return this.${entityCamel}s.create(draft);
  }

  async update(id: string, patch: ${entityPascal}Patch): Promise<${entityPascal}> {
    // Read-then-write is two operations against one row, so it runs in one
    // transaction: without it a concurrent delete between the two leaves
    // update() returning undefined for a row this method already proved
    // present.
    return this.${entityCamel}s.transaction(async (repository) => {
      const existing = await repository.findById(id);
      if (!existing) {
        throw new ${entityPascal}NotFoundError(id);
      }
      const updated = await repository.update(id, patch);
      if (!updated) {
        throw new ${entityPascal}NotFoundError(id);
      }
      return updated;
    });
  }

  async remove(id: string): Promise<void> {
    const removed = await this.${entityCamel}s.remove(id);
    if (!removed) {
      throw new ${entityPascal}NotFoundError(id);
    }
  }${toggleField ? toggleMethod(names, toggleField) : ''}
}
`;
}

function serviceSpecFile(names: ModuleNames, toggleField?: string): string {
  const { entityPascal, entityCamel, entityKebab } = names;

  return `import { describe, expect, it, vi } from 'vitest';
import type { ${entityPascal}Repository } from '${names.module}-repository';
import { ${entityPascal}NotFoundError } from './${entityKebab}.errors';
import { ${entityPascal}Service } from './${entityKebab}.service';

function repositoryDouble(
  overrides: Partial<${entityPascal}Repository> = {},
): ${entityPascal}Repository {
  const repository: ${entityPascal}Repository = {
    findAll: vi.fn(async () => []),
    findById: vi.fn(async () => undefined),
    create: vi.fn(async (draft) => ({ id: 'created', ...draft }) as never),
    update: vi.fn(async () => undefined),
    remove: vi.fn(async () => false),
    transaction: vi.fn(async (work) => work(repository)),
    ...overrides,
  };
  return repository;
}

describe('${entityPascal}Service', () => {
  it('throws a named domain error when a ${entityCamel} is absent', async () => {
    const service = new ${entityPascal}Service(repositoryDouble());

    await expect(service.getById('missing')).rejects.toBeInstanceOf(
      ${entityPascal}NotFoundError,
    );
    await expect(service.getById('missing')).rejects.toMatchObject({
      name: '${entityPascal}NotFoundError',
    });
  });

  it('returns the row the repository found, unparsed', async () => {
    const row = { id: 'present' } as never;
    const service = new ${entityPascal}Service(
      repositoryDouble({ findById: vi.fn(async () => row) }),
    );

    await expect(service.getById('present')).resolves.toBe(row);
  });

  it('runs a read-then-write update inside one transaction', async () => {
    const repository = repositoryDouble({
      findById: vi.fn(async () => ({ id: 'present' }) as never),
      update: vi.fn(async () => ({ id: 'present' }) as never),
    });
    const service = new ${entityPascal}Service(repository);

    await service.update('present', {} as never);

    expect(repository.transaction).toHaveBeenCalledOnce();
  });

  it('turns a delete that matched nothing into a not-found error', async () => {
    const service = new ${entityPascal}Service(repositoryDouble());

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      ${entityPascal}NotFoundError,
    );
  });
${
  toggleField
    ? `
  it('derives the new ${toggleField} from stored state, not from the caller', async () => {
    const repository = repositoryDouble({
      findById: vi.fn(async () => ({ id: 'present', ${toggleField}: true }) as never),
      update: vi.fn(async (_id, patch) => ({ id: 'present', ...patch }) as never),
    });
    const service = new ${entityPascal}Service(repository);

    await service.toggle${entityPascal}('present');

    expect(repository.update).toHaveBeenCalledWith('present', {
      ${toggleField}: false,
    });
    expect(repository.transaction).toHaveBeenCalledOnce();
  });

  it('flips twice back to the original value, so no flip is lost', async () => {
    let stored = false;
    const repository = repositoryDouble({
      findById: vi.fn(async () => ({ id: 'present', ${toggleField}: stored }) as never),
      update: vi.fn(async (_id, patch) => {
        stored = (patch as { ${toggleField}: boolean }).${toggleField};
        return { id: 'present', ${toggleField}: stored } as never;
      }),
    });
    const service = new ${entityPascal}Service(repository);

    await service.toggle${entityPascal}('present');
    expect(stored).toBe(true);
    await service.toggle${entityPascal}('present');
    expect(stored).toBe(false);
  });

  it('rejects a toggle against a ${entityCamel} that is not there', async () => {
    const service = new ${entityPascal}Service(repositoryDouble());

    await expect(service.toggle${entityPascal}('missing')).rejects.toBeInstanceOf(
      ${entityPascal}NotFoundError,
    );
  });
`
    : ''
}});
`;
}

function barrelFile(names: ModuleNames): string {
  return `export * from './lib/${names.entityKebab}.errors';
export * from './lib/${names.entityKebab}.service';
`;
}
