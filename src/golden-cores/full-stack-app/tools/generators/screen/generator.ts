import { formatFiles, Tree, updateJson } from '@nx/devkit';
import { moduleNames, ModuleNames } from '../naming';

interface ScreenGeneratorOptions {
  module: string;
}

const WEB_ROOT = 'apps/web';

/**
 * Deliberately a skeleton: it wires the hook layer to a route and leaves
 * placeholders for the list, the filter shell, the empty state, and the
 * create/edit form. Layout, information hierarchy, and every other UX
 * judgment belong to ux-planner's rationale and front-end-eng's build, not
 * to a template that would make every module's screen look identical
 * before anyone decided it should.
 */
export default async function screenGenerator(
  tree: Tree,
  options: ScreenGeneratorOptions,
) {
  const names = moduleNames(options.module);
  const dir = `${WEB_ROOT}/src/app/${names.module}`;

  tree.write(`${dir}/page.tsx`, pageFile(names));
  tree.write(`${dir}/${names.module}-screen.tsx`, screenFile(names));
  tree.write(`${dir}/${names.module}-form.tsx`, formFile(names));
  tree.write(`${dir}/${names.module}-screen.spec.tsx`, specFile(names));

  addWebDependencies(tree);

  await formatFiles(tree);
}

function pageFile(names: ModuleNames): string {
  return `import { ${names.pascal}Screen } from './${names.module}-screen';

export default function ${names.pascal}Page() {
  return <${names.pascal}Screen />;
}
`;
}

function screenFile(names: ModuleNames): string {
  const { pascal, camel, entityPascal } = names;

  return `'use client';

import { useState } from 'react';
import { useRemove${entityPascal}, use${pascal} } from 'hooks';
import { ${pascal}Form } from './${names.module}-form';

export function ${pascal}Screen() {
  const { data, isPending, isError } = use${pascal}();
  const remove${entityPascal} = useRemove${entityPascal}();
  const [editingId, setEditingId] = useState<string | null>(null);

  if (isPending) {
    return <p>Loading ${names.module}…</p>;
  }

  if (isError) {
    return <p>${pascal} could not be loaded.</p>;
  }

  const ${camel} = data ?? [];

  return (
    <main>
      <header>
        <h1>${pascal}</h1>
        {/* Filter and tab shell — front-end-eng decides which facets a
            ${names.entityCamel} is filtered by, from ux-planner's rationale. */}
        <nav aria-label="${pascal} filters" />
      </header>

      <${pascal}Form
        editingId={editingId}
        onDone={() => setEditingId(null)}
      />

      {${camel}.length === 0 ? (
        <p>No ${names.module} yet.</p>
      ) : (
        <ul>
          {${camel}.map((${names.entityCamel}) => (
            <li key={${names.entityCamel}.id}>
              <button type="button" onClick={() => setEditingId(${names.entityCamel}.id)}>
                Edit
              </button>
              <button
                type="button"
                onClick={() => remove${entityPascal}.mutate(${names.entityCamel}.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
`;
}

function formFile(names: ModuleNames): string {
  const { pascal, entityPascal, entityCamel } = names;

  return `'use client';

import { useCreate${entityPascal} } from 'hooks';

interface ${pascal}FormProps {
  editingId: string | null;
  onDone: () => void;
}

export function ${pascal}Form({ editingId, onDone }: ${pascal}FormProps) {
  const create${entityPascal} = useCreate${entityPascal}();

  return (
    <form
      aria-label={editingId ? 'Edit ${entityCamel}' : 'Create ${entityCamel}'}
      onSubmit={(event) => {
        event.preventDefault();
        onDone();
      }}
    >
      {/* Fields, validation feedback, and submit affordance are
          front-end-eng's, built against the contract's own create/update
          schema rather than duplicated here. */}
      <button type="submit" disabled={create${entityPascal}.isPending}>
        Save
      </button>
    </form>
  );
}
`;
}

function specFile(names: ModuleNames): string {
  const { pascal, entityPascal } = names;

  return `import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ${pascal}Screen } from './${names.module}-screen';

// Hoisted above the import above by Vitest, which is what lets the screen
// render against stubbed hooks instead of a live API.
vi.mock('hooks', () => ({
  use${pascal}: vi.fn(() => ({ data: [], isPending: false, isError: false })),
  useCreate${entityPascal}: vi.fn(() => ({ isPending: false, mutate: vi.fn() })),
  useRemove${entityPascal}: vi.fn(() => ({ isPending: false, mutate: vi.fn() })),
}));

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <${pascal}Screen />
    </QueryClientProvider>,
  );
}

describe('${pascal}Screen', () => {
  it('renders the empty state when the hook returns no rows', () => {
    renderScreen();

    expect(screen.getByText(/no ${names.module} yet/i)).toBeInTheDocument();
  });

  it('renders the filter shell and the create form', () => {
    renderScreen();

    expect(
      screen.getByRole('navigation', { name: /${names.module} filters/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('form', { name: /create /i }),
    ).toBeInTheDocument();
  });
});
`;
}

/**
 * apps/web consumes the hook package as TypeScript source, so the
 * dependency and the project reference both have to exist before the
 * screen's own import resolves.
 */
function addWebDependencies(tree: Tree) {
  updateJson(tree, `${WEB_ROOT}/package.json`, (json) => {
    json.dependencies = {
      ...json.dependencies,
      contracts: 'workspace:*',
      hooks: 'workspace:*',
    };
    return json;
  });

  for (const config of ['tsconfig.json', 'tsconfig.spec.json']) {
    updateJson(tree, `${WEB_ROOT}/${config}`, (json) => {
      const references: { path: string }[] = json.references ?? [];
      for (const path of ['../../packages/contracts', '../../packages/hooks']) {
        if (!references.some((entry) => entry.path === path)) {
          references.push({ path });
        }
      }
      json.references = references;
      return json;
    });
  }
}
