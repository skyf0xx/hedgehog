import { controllerGenerator, moduleGenerator } from '@nx/nest';
import { formatFiles, Tree, updateJson } from '@nx/devkit';
import { Field, isDateField, parseFields } from '../fields';
import { moduleNames, ModuleNames } from '../naming';

interface ControllerGeneratorOptions {
  module: string;
  fields: string;
  toggleField?: string;
}

const API_ROOT = 'apps/api';

export default async function controllerGenerator_(
  tree: Tree,
  options: ControllerGeneratorOptions,
) {
  const names = moduleNames(options.module);
  const fields = parseFields(options.fields);
  const dir = `${API_ROOT}/src/app/${names.module}`;
  const stem = `${dir}/${names.module}`;

  // The Nest generators own the module/controller shell so it cannot drift
  // from a hand-copied sibling. `skipImport` is required: registration
  // happens through the generated feature-modules.ts barrel, which globs
  // apps/api/src/app/*/*.module.ts — the file this generator writes is
  // picked up automatically by the generate-feature-modules Nx target that
  // build, typecheck, and test all depend on. Nothing here edits
  // app.module.ts.
  await moduleGenerator(tree, {
    path: stem,
    skipImport: true,
    skipFormat: true,
  });
  await controllerGenerator(tree, {
    path: stem,
    skipImport: true,
    unitTestRunner: 'none',
    skipFormat: true,
  });

  // @nx/nest:controller emits @Controller('<name>') — a base path derived
  // from the file name. The ts-rest contract already encodes every route's
  // full path, so leaving it would prefix each route twice.
  stripControllerBasePath(tree, `${stem}.controller.ts`);

  tree.write(
    `${stem}.controller.ts`,
    controllerFile(names, fields, options.toggleField),
  );
  tree.write(`${stem}.module.ts`, moduleFile(names));
  tree.write(
    `${stem}.controller.spec.ts`,
    controllerSpecFile(names, options.toggleField),
  );

  addApiDependencies(tree, names);

  await formatFiles(tree);
}

/**
 * Rewrites the generator's own decorator in place, so the strip is proved
 * against what it actually emitted rather than assumed from its templates.
 */
function stripControllerBasePath(tree: Tree, path: string) {
  const source = tree.read(path, 'utf-8');
  if (!source) return;
  tree.write(path, source.replace(/@Controller\((['"]).*?\1\)/, '@Controller()'));
}

function controllerFile(
  names: ModuleNames,
  fields: Field[],
  toggleField?: string,
): string {
  const { entityPascal, entityCamel, camel, module } = names;
  const dateFields = fields.filter(isDateField);
  const wireShape = dateFields.length
    ? `{ ${dateFields
        .map(
          (field) =>
            `${field.name}${field.nullable ? '?' : ''}: Date | string${field.nullable ? ' | null' : ''}`,
        )
        .join('; ')} }`
    : 'object';

  return `import { Controller, Inject } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { ${camel}Contract } from 'contracts';
import { ${entityPascal}Service } from '${module}-service';

// No base path: the ts-rest contract carries each route's full path, and
// apps/api/src/main.ts adds the one /api prefix the whole app shares.
@Controller()
export class ${names.pascal}Controller {
  constructor(
    @Inject(${entityPascal}Service) private readonly ${entityCamel}s: ${entityPascal}Service,
  ) {}

  @TsRestHandler(${camel}Contract)
  async handler() {
    return tsRestHandler(${camel}Contract, {
      list: async () => ({
        status: 200 as const,
        body: await this.${entityCamel}s.list(),
      }),

      get: async ({ params }) => {
        try {
          return {
            status: 200 as const,
            body: await this.${entityCamel}s.getById(params.id),
          };
        } catch (error) {
          return notFoundOr(error, params.id);
        }
      },

      create: async ({ body }) => ({
        status: 201 as const,
        body: await this.${entityCamel}s.create(fromWire(body)),
      }),

      update: async ({ params, body }) => {
        try {
          return {
            status: 200 as const,
            body: await this.${entityCamel}s.update(params.id, fromWire(body)),
          };
        } catch (error) {
          return notFoundOr(error, params.id);
        }
      },

      remove: async ({ params }) => {
        try {
          await this.${entityCamel}s.remove(params.id);
          return { status: 204 as const, body: undefined };
        } catch (error) {
          return notFoundOr(error, params.id);
        }
      },${
        toggleField
          ? `

      // The id is the whole request: the service reads the current value
      // and flips it inside its own transaction, so there is no client
      // value here that could be stale.
      toggle: async ({ params }) => {
        try {
          return {
            status: 200 as const,
            body: await this.${entityCamel}s.toggle${entityPascal}(params.id),
          };
        } catch (error) {
          return notFoundOr(error, params.id);
        }
      },`
          : ''
      }
    });
  }
}

/**
 * The one place a domain error becomes a status code — services throw
 * ${entityPascal}NotFoundError knowing nothing about HTTP. Matching on
 * \`name\` rather than \`instanceof\` survives the error class arriving
 * through a separately bundled copy of ${module}-service.
 */
function notFoundOr(error: unknown, id: string) {
  if (error instanceof Error && error.name === '${entityPascal}NotFoundError') {
    return {
      status: 404 as const,
      body: {
        error: '${entityPascal}NotFound' as const,
        message: \`No ${entityCamel} exists with id \${id}.\`,
      },
    };
  }
  throw error;
}

/**
 * The seam the contract's date-mode timestamp union creates: the same
 * field is a real Date server-side and an ISO string over JSON, so the
 * contract accepts both and this boundary picks one — the Date the
 * repository's column type actually stores. Past here nothing re-parses.
 */
function fromWire<T extends ${wireShape}>(body: T) {
  return {
    ...body,${dateFields
      .map(
        (field) =>
          `\n    ${field.name}: toDate(body.${field.name}),`,
      )
      .join('')}
  };
}

${
  dateFields.length
    ? `function toDate(value: Date | string | null | undefined) {
  return typeof value === 'string' ? new Date(value) : value;
}
`
    : ''
}`;
}

function moduleFile(names: ModuleNames): string {
  const { entityPascal, entityConstant, pascal, module } = names;

  return `import { Module } from '@nestjs/common';
import { getDb } from 'db';
import {
  ${entityConstant}_REPOSITORY,
  Drizzle${entityPascal}Repository,
} from '${module}-repository';
import { ${entityPascal}Service } from '${module}-service';
import { ${pascal}Controller } from './${names.module}.controller';

// The composition root for this module, and the only file in apps/api
// allowed to name a *.adapter (eslint-base.js exempts *.module.ts from the
// port-discipline rule precisely for this binding).
//
// Registration is automatic: tools/generate-feature-modules.cjs globs
// every module directory's own *.module.ts into feature-modules.ts, which
// app.module.ts spreads — so this file is never referenced by hand.
@Module({
  controllers: [${pascal}Controller],
  providers: [
    {
      provide: ${entityConstant}_REPOSITORY,
      // getDb is passed unevaluated: the DI container builds every provider
      // eagerly, and calling it here would open a database connection just
      // to compile the module — including inside a test.
      useFactory: () => new Drizzle${entityPascal}Repository(getDb),
    },
    {
      provide: ${entityPascal}Service,
      inject: [${entityConstant}_REPOSITORY],
      useFactory: (repository: Drizzle${entityPascal}Repository) =>
        new ${entityPascal}Service(repository),
    },
  ],
})
export class ${pascal}Module {}
`;
}

function controllerSpecFile(names: ModuleNames, toggleField?: string): string {
  const { entityPascal, pascal, module } = names;

  return `import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { ${entityPascal}Service } from '${module}-service';
import { ${pascal}Controller } from './${names.module}.controller';

async function controllerWith(service: Partial<${entityPascal}Service>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [${pascal}Controller],
    providers: [{ provide: ${entityPascal}Service, useValue: service }],
  }).compile();

  return moduleRef.get(${pascal}Controller);
}

describe('${pascal}Controller', () => {
  it('serves the contract without a base path of its own', () => {
    const path = Reflect.getMetadata('path', ${pascal}Controller);

    expect(path).toBe('/');
  });

  it('answers list with 200 and the rows the service returned', async () => {
    const rows = [{ id: 'one' }];
    const controller = await controllerWith({
      list: vi.fn(async () => rows as never),
    });

    const handler = await controller.handler();
    const response = await handler.list({} as never);

    expect(response).toMatchObject({ status: 200, body: rows });
  });

  it('maps a not-found domain error to 404 rather than letting it escape', async () => {
    const notFound = Object.assign(new Error('absent'), {
      name: '${entityPascal}NotFoundError',
    });
    const controller = await controllerWith({
      getById: vi.fn(async () => {
        throw notFound;
      }),
    });

    const handler = await controller.handler();
    const response = await handler.get({
      params: { id: 'missing' },
    } as never);

    expect(response).toMatchObject({ status: 404 });
  });

  it('lets an error it has no mapping for propagate', async () => {
    const boom = new Error('database is on fire');
    const controller = await controllerWith({
      getById: vi.fn(async () => {
        throw boom;
      }),
    });

    const handler = await controller.handler();

    await expect(
      handler.get({ params: { id: 'any' } } as never),
    ).rejects.toBe(boom);
  });
${
  toggleField
    ? `
  it('passes only the id to the service, so no client value reaches the write', async () => {
    const toggle${entityPascal} = vi.fn(async () => ({ id: 'one' }) as never);
    const controller = await controllerWith({ toggle${entityPascal} });

    const handler = await controller.handler();
    const response = await handler.toggle({
      params: { id: 'one' },
    } as never);

    expect(toggle${entityPascal}).toHaveBeenCalledWith('one');
    expect(response).toMatchObject({ status: 200 });
  });

  it('maps a not-found on toggle to 404', async () => {
    const controller = await controllerWith({
      toggle${entityPascal}: vi.fn(async () => {
        throw Object.assign(new Error('absent'), {
          name: '${entityPascal}NotFoundError',
        });
      }),
    });

    const handler = await controller.handler();
    const response = await handler.toggle({
      params: { id: 'missing' },
    } as never);

    expect(response).toMatchObject({ status: 404 });
  });
`
    : ''
}});
`;
}

/**
 * apps/api reaches the module's service and repository libs, plus the
 * contract package, by construction — declared here so the first module
 * through this layer does not leave them unlinked for a later layer to
 * trip over.
 */
function addApiDependencies(tree: Tree, names: ModuleNames) {
  updateJson(tree, `${API_ROOT}/package.json`, (json) => {
    json.dependencies = {
      ...json.dependencies,
      contracts: 'workspace:*',
      [`${names.module}-repository`]: 'workspace:*',
      [`${names.module}-service`]: 'workspace:*',
    };
    return json;
  });

  updateJson(tree, `${API_ROOT}/tsconfig.app.json`, (json) => {
    const references: { path: string }[] = json.references ?? [];
    for (const path of [
      '../../packages/contracts/tsconfig.lib.json',
      `../../libs/${names.module}/repository/tsconfig.lib.json`,
      `../../libs/${names.module}/service/tsconfig.lib.json`,
    ]) {
      if (!references.some((entry) => entry.path === path)) {
        references.push({ path });
      }
    }
    json.references = references;
    return json;
  });
}
