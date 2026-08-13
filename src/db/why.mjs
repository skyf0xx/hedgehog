// `hedgehog why <path>` — walks artifacts → tasks → task_requirements →
// requirements → intents for a given file path, printing the full
// provenance chain. See hedgehog-persistent-build-graph.md,
// "Traceability": artifact → task (with its verification) → requirement
// → intent.

function loadArtifacts(db, path) {
  return db
    .prepare('SELECT * FROM artifacts WHERE path = ? ORDER BY id')
    .all(path);
}

function loadTask(db, taskId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
}

// Most recent verification for the task — the one that proved the
// artifact, per "Traceability"'s "verified: pnpm nx test db, exit 0".
function loadLatestVerification(db, taskId) {
  return db
    .prepare(
      `
      SELECT * FROM verifications
      WHERE task_id = ?
      ORDER BY id DESC
      LIMIT 1
    `,
    )
    .get(taskId);
}

function loadTaskRequirements(db, taskId) {
  return db
    .prepare(
      `
      SELECT r.* FROM requirements r
      JOIN task_requirements tr ON tr.requirement_id = r.id
      WHERE tr.task_id = ?
    `,
    )
    .all(taskId);
}

function loadIntent(db, intentId) {
  return db.prepare('SELECT * FROM intents WHERE id = ?').get(intentId);
}

// Walks the chain for one artifact row: its task, that task's latest
// verification, the requirements it satisfies, and their owning intent.
function traceArtifact(db, artifact) {
  const task = loadTask(db, artifact.task_id);
  const verification = task ? loadLatestVerification(db, task.id) : null;
  const requirements = task ? loadTaskRequirements(db, task.id) : [];
  const intent = task ? loadIntent(db, task.intent_id) : null;
  return { artifact, task, verification, requirements, intent };
}

// Returns the full provenance chain for `path`: one entry per artifacts
// row (a path can be touched by more than one task across its history),
// each carrying its task, latest verification, requirements, and intent.
// Empty array when the path has never been recorded as an artifact.
export function whyPath(db, path) {
  return loadArtifacts(db, path).map((artifact) => traceArtifact(db, artifact));
}

function formatVerification(verification) {
  if (!verification) return '(no verification recorded)';
  return `${verification.command} — exit ${verification.exit_code}, ${verification.status}`;
}

// Renders whyPath()'s chain into the artifact → task → requirement →
// intent shape from the spec's "Traceability" diagram.
//
// An empty chain means exactly one thing regardless of core: no task
// this build graph ever ran wrote or touched this path. On a brownfield
// adoption (hedgehog-adopt) that's the ordinary case for almost every
// file in the repo — the graph is change-scoped by design and never
// backfills a record for code that predates adoption — so the message
// says that plainly rather than reading as a broken lookup.
export function formatWhy(path, chain) {
  if (chain.length === 0) {
    return (
      `${path}\n  (no artifact recorded for this path — no task in this build graph ` +
      `ever wrote it; on an adopted repo this is expected for any file that predates ` +
      `Hedgehog, not an error)`
    );
  }

  const lines = [];
  lines.push(path);
  for (const { task, verification, requirements, intent } of chain) {
    lines.push(`  ↑ artifact of`);
    lines.push(`${task.id}  (verified: ${formatVerification(verification)})`);
    if (requirements.length === 0) {
      lines.push(`  ↑ satisfies`);
      lines.push(`(no requirements linked)`);
    } else {
      for (const req of requirements) {
        lines.push(`  ↑ satisfies`);
        lines.push(`requirement: "${req.statement}"`);
      }
    }
    lines.push(`  ↑ of`);
    lines.push(`intent: ${intent.id}`);
  }

  return lines.join('\n');
}
