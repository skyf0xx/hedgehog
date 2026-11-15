// `hedgehog graph` — read-only dependency-graph export for the build
// graph: every task as a node, every `dependencies` row as an edge. See
// BUILD_GRAPH.md, "Schema", for the `tasks` and `dependencies` tables
// this mirrors.
//
// This module only shapes rows into { nodes, edges }; layout and
// rendering live in src/templates/graph.html (served by graph-server.mjs),
// not here — the
// same separation status.mjs keeps between graphStatus() (data) and
// formatStatus() (text rendering).

const ALL_TASKS_SQL = `
  SELECT t.*, i.goal AS intent_goal FROM tasks t
  JOIN intents i ON i.id = t.intent_id
  ORDER BY t.priority, t.id;
`;

const ALL_DEPENDENCIES_SQL = `
  SELECT task_id, depends_on_task_id FROM dependencies;
`;

// One query for every task's requirement links, not one query per task —
// this runs on every poll (see graph-server.mjs), so an N+1 here would
// mean N+1 queries every 2 seconds rather than once.
const ALL_TASK_REQUIREMENTS_SQL = `
  SELECT tr.task_id, r.kind, r.statement
  FROM task_requirements tr
  JOIN requirements r ON r.id = tr.requirement_id
  ORDER BY tr.task_id, r.id;
`;

function loadAllTasks(db) {
  return db.prepare(ALL_TASKS_SQL).all();
}

function loadAllDependencies(db) {
  return db.prepare(ALL_DEPENDENCIES_SQL).all();
}

function loadAllTaskRequirements(db) {
  return db.prepare(ALL_TASK_REQUIREMENTS_SQL).all();
}

// Groups the flat requirement rows by task_id, same rule/constraint/
// acceptance mix hedgehog next's RELEVANT RULES section shows — a task
// is bound by all three kinds equally, so the graph's detail panel
// doesn't split them out either.
function groupRequirementsByTask(rows) {
  const byTask = new Map();
  for (const row of rows) {
    if (!byTask.has(row.task_id)) byTask.set(row.task_id, []);
    byTask.get(row.task_id).push({ kind: row.kind, statement: row.statement });
  }
  return byTask;
}

// Shapes the full build graph into { nodes, edges } for the viewer.
// Each node carries exactly the fields the viewer displays on click
// (objective, verify_command, commit_message, requirements) plus the
// fields that drive layout and status colour — nothing the viewer
// doesn't render.
export function buildGraph(db) {
  const tasks = loadAllTasks(db);
  const dependencies = loadAllDependencies(db);
  const requirementsByTask = groupRequirementsByTask(loadAllTaskRequirements(db));

  const nodes = tasks.map((t) => ({
    id: t.id,
    module: t.module,
    layer: t.layer,
    status: t.status,
    lease_owner: t.lease_owner,
    objective: t.objective,
    verifyCommand: t.verify_command,
    commitMessage: t.commit_message,
    intentGoal: t.intent_goal,
    requirements: requirementsByTask.get(t.id) ?? [],
  }));

  // Edge direction follows the dependency, not the SQL column order:
  // `depends_on_task_id` must finish before `task_id` can start, so the
  // arrow is drawn from the prerequisite to the dependent — the same
  // direction hedgehog next's BLOCKED DOWNSTREAM walk assumes.
  const edges = dependencies.map((d) => ({
    id: `${d.depends_on_task_id}->${d.task_id}`,
    source: d.depends_on_task_id,
    target: d.task_id,
  }));

  return { nodes, edges };
}
