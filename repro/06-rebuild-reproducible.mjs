// `hedgehog db rebuild` replays the committed intents through the same
// planTasks path, so a once-layer's compiled form has to be a function of
// core.yaml plus the intent set — never of the order intents happened to
// be added in.
//
// The intents here are added in an order that inverts their sort order
// ("zeta" first, "alpha" second). Attributing the once-task to "whichever
// intent compiled it" would put it under zeta live and under alpha after
// a rebuild; deriving it from the core instead makes both identical.
//
// Against the pre-cardinality compiler this fails on cardinality alone —
// there is no single once-task to be reproducible about.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, addIntent, cli, dumpGraph, tasksForLayer, cleanup, check, report, ONCE_CORE } from './_lib.mjs';

const dir = makeProject(ONCE_CORE, { git: true });
try {
  addIntent(dir, 'zeta');
  check('first plan exits 0', 0, cli(dir, ['plan']).status);
  addIntent(dir, 'alpha');
  check('second plan exits 0', 0, cli(dir, ['plan']).status);

  check(
    'one cluster task, owned by the core rather than by zeta',
    [{ id: 'CLUSTER', module: '_core', intent_id: '_core' }],
    tasksForLayer(dir, 'cluster'),
  );

  const live = dumpGraph(dir);

  // Drop the derived index entirely and replay from .hedgehog/intents/*
  // plus .hedgehog/core.yaml, which is what a fresh clone does.
  rmSync(join(dir, '.hedgehog/hedgehog.db'), { force: true });
  rmSync(join(dir, '.hedgehog/hedgehog.db-wal'), { force: true });
  rmSync(join(dir, '.hedgehog/hedgehog.db-shm'), { force: true });
  const rebuilt = cli(dir, ['db', 'rebuild']);
  check('db rebuild exits 0', 0, rebuilt.status);

  const after = dumpGraph(dir);
  check('rebuilt intents match', live.intents, after.intents);
  check('rebuilt tasks match', live.tasks, after.tasks);
  check('rebuilt dependency rows match', live.dependencies, after.dependencies);
  check('rebuilt requirement links match', live.task_requirements, after.task_requirements);
} finally {
  cleanup(dir);
}

report('06 — a once layer survives db rebuild unchanged');
