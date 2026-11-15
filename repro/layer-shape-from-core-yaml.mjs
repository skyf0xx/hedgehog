// LAYER SHAPE and out-of-scope hints come from the active core.yaml, for
// any core that declares them.
//
//   1. A layer declaring `tags`, `depends_on_tags` and `scaffold` gets a
//      LAYER SHAPE section with {module} filled in and the core's
//      `layer_shape_note` as its closing lines; an empty
//      `depends_on_tags` renders as a floor layer.
//   2. A layer of the same core that declares none of them, and every
//      layer of a core that declares none, gets no section.
//   3. A `scope_hints` entry annotates a matching out-of-scope path at
//      `hedgehog verify`; a path no entry matches gets no annotation,
//      and `.hedgehog/` keeps the build-graph hint on every core.
//   4. A `scope_hints` block placed after `layers` leaves the layers
//      parsed, which is where a core puts it.
//   5. A malformed `scope_hints` glob is a load error naming the glob.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeProject, addIntent, cli, cleanup, check, checkContains, report } from './_lib.mjs';
import { parseCoreYaml, validateCore } from '../src/db/core.mjs';

const SHAPED = `
id: shaped-fixture
pattern: vertical-slice
layer_shape_note: "Check lint/rules.js before an import.\\nStart from the generator."
layers:
  - id: entity
    scope: ["src/entities/{module}/**"]
    verify: "true"
    commit: "feat({module}): entity"
    tags: ["layer:entity", "scope:{module}"]
    depends_on_tags: []
    scaffold: "gen entity --name={module}"
  - id: feature
    depends_on: entity
    scope: ["src/features/{module}/**"]
    verify: "true"
    commit: "feat({module}): feature"
    tags: ["layer:feature"]
    depends_on_tags: ["layer:entity", "layer:util"]
  - id: wire
    depends_on: feature
    scope: ["src/wire/{module}/**"]
    verify: "true"
    commit: "feat({module}): wire"
scope_hints:
  - match: ["src/*/package.json", "shared/**"]
    hint: "fixture hint — commit it separately"
`;

const PLAIN = `
id: plain-fixture
layers:
  - id: entity
    scope: ["src/entities/{module}/**"]
    verify: "true"
    commit: "feat({module}): entity"
`;

const dir = makeProject(SHAPED, { git: true });
try {
  addIntent(dir, 'notes');
  check('plan exits 0', 0, cli(dir, ['plan']).status);

  const entity = cli(dir, ['show', 'NOTES-ENTITY']).stdout;
  checkContains(
    'a layer declaring tags, depends_on_tags and scaffold gets the full section',
    entity,
    [
      'LAYER SHAPE',
      "  this layer's tags:      layer:entity, scope:notes",
      '  may depend on tags:     (nothing in-workspace — floor layer)',
      '  scaffold from:          gen entity --name=notes',
      '  Check lint/rules.js before an import.',
      '  Start from the generator.',
      '',
      'VERIFICATION',
    ].join('\n'),
  );

  const feature = cli(dir, ['show', 'NOTES-FEATURE']).stdout;
  checkContains(
    'declared tags without a scaffold print the tag lines only',
    feature,
    [
      'LAYER SHAPE',
      "  this layer's tags:      layer:feature",
      '  may depend on tags:     layer:entity, layer:util',
      '  Check lint/rules.js before an import.',
    ].join('\n'),
  );
  check('and no scaffold line', false, feature.includes('scaffold from:'));

  const wire = cli(dir, ['show', 'NOTES-WIRE']).stdout;
  check('a layer declaring no shape fields gets no section', false, wire.includes('LAYER SHAPE'));

  // Scope hints at verify: claim the floor layer, write a hinted path and
  // an unhinted one outside its scope.
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: plan'], { cwd: dir });
  check('claim exits 0', 0, cli(dir, ['claim', 'NOTES-ENTITY', '--owner', 'repro']).status);
  mkdirSync(join(dir, 'src/entities/notes'), { recursive: true });
  writeFileSync(join(dir, 'src/entities/notes/index.ts'), 'export {};\n');
  writeFileSync(join(dir, 'src/entities/package.json'), '{}\n');
  mkdirSync(join(dir, 'elsewhere'), { recursive: true });
  writeFileSync(join(dir, 'elsewhere/stray.ts'), 'export {};\n');
  const verify = cli(dir, ['verify', 'NOTES-ENTITY', '--owner', 'repro']);
  check('verify reports a scope violation', 1, verify.status);
  checkContains(
    'a path a scope_hints entry matches carries that hint',
    verify.stderr,
    'src/entities/package.json\n      fixture hint — commit it separately',
  );
  checkContains('the unhinted path is still reported', verify.stderr, 'elsewhere/stray.ts\n');
  check(
    'and carries no hint',
    false,
    /elsewhere\/stray\.ts\n {6}\S/.test(verify.stderr),
  );
} finally {
  cleanup(dir);
}

const plain = makeProject(PLAIN, { git: true });
try {
  addIntent(plain, 'notes');
  check('plain core: plan exits 0', 0, cli(plain, ['plan']).status);
  const packet = cli(plain, ['show', 'NOTES-ENTITY']).stdout;
  check('a core declaring no shape fields gets no LAYER SHAPE', false, packet.includes('LAYER SHAPE'));
  checkContains('and the packet still renders through VERIFICATION', packet, 'VERIFICATION');
} finally {
  cleanup(plain);
}

const parsed = parseCoreYaml(SHAPED);
check('scope_hints after layers leaves every layer parsed', 3, parsed.layers.length);
check('and parses the hint', 'fixture hint — commit it separately', parsed.scope_hints[0]?.hint);

let loadError = '';
try {
  validateCore(parseCoreYaml(SHAPED.replace('"shared/**"', '"shared/[z-a].ts"')));
} catch (err) {
  loadError = err.message;
}
checkContains('a malformed scope_hints glob fails the load', loadError, 'malformed glob "shared/[z-a].ts"');

report('LAYER SHAPE and scope hints come from core.yaml for any core');
