// `hedgehog why <path>` — walks artifacts → tasks → task_requirements →
// requirements → intents for a given file path, printing the full
// provenance chain. See hedgehog-persistent-build-graph.md,
// "Traceability": artifact → task (with its verification) → requirement
// → intent.
import { execFileSync } from 'node:child_process';

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
  return traceTask(db, loadTask(db, artifact.task_id), artifact);
}

function traceTask(db, task, artifact, commit = null) {
  const verification = task ? loadLatestVerification(db, task.id) : null;
  const requirements = task ? loadTaskRequirements(db, task.id) : [];
  const intent = task ? loadIntent(db, task.intent_id) : null;
  return { artifact, task, verification, requirements, intent, commit };
}

// `db rebuild` does not refill the artifacts table, so a path's history
// is also recoverable from git: a commit that touched the path whose
// subject equals a task's commit_message names that task. Entries come
// back most recent commit first, one per task.
function traceFromGit(db, path, cwd) {
  let out;
  try {
    out = execFileSync(
      'git',
      ['--literal-pathspecs', 'log', '--follow', '--format=%H%x00%s', '--', path],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch {
    return Object.assign([], { gitFailed: true });
  }
  const byMessage = db.prepare('SELECT * FROM tasks WHERE commit_message = ? ORDER BY id');
  const seen = new Set();
  const chain = [];
  for (const line of out.split('\n')) {
    const [hash, subject] = line.split('\0');
    if (!hash || subject === undefined) continue;
    for (const task of byMessage.all(subject)) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      chain.push(traceTask(db, task, null, hash));
    }
  }
  return chain;
}

// Returns the full provenance chain for `path`: one entry per artifacts
// row (a path can be touched by more than one task across its history),
// each carrying its task, latest verification, requirements, and intent.
// When no artifacts row exists, the chain is derived from git history
// (entries carry `commit` and a null `artifact`). Empty array when
// neither source names a task; the empty array carries `gitFailed` when
// git itself could not be read.
export function whyPath(db, path, cwd = process.cwd()) {
  const rows = loadArtifacts(db, path);
  if (rows.length > 0) return rows.map((artifact) => traceArtifact(db, artifact));
  return traceFromGit(db, path, cwd);
}

function formatVerification(verification) {
  if (!verification) return '(no verification recorded)';
  return `${verification.command} — exit ${verification.exit_code}, ${verification.status}`;
}

// Renders whyPath()'s chain into the artifact → task → requirement →
// intent shape from the spec's "Traceability" diagram.
//
// An empty chain means no artifact row and no commit touching the path
// carries a task's commit message. On a brownfield adoption
// (hedgehog-adopt) that's the ordinary case for almost every file in the
// repo — the graph is change-scoped and never backfills code that
// predates adoption — so the message says that plainly.
export function formatWhy(path, chain) {
  if (chain.length === 0 && chain.gitFailed) {
    return (
      `${path}\n  (no artifact row, and git history could not be read to look ` +
      `for a task's commit)`
    );
  }
  if (chain.length === 0) {
    return (
      `${path}\n  (no artifact row and no commit touching this path matches a task's ` +
      `commit message; on an adopted repo this is expected for any file that predates ` +
      `Hedgehog, not an error)`
    );
  }

  const lines = [];
  lines.push(path);
  for (const { task, verification, requirements, intent, commit } of chain) {
    lines.push(
      commit
        ? `  ↑ touched by commit ${commit.slice(0, 7)} (derived from git history) of`
        : `  ↑ artifact of`,
    );
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
