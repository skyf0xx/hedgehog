// The Hedgehog build graph schema — see hedgehog-persistent-build-graph.md,
// "SQLite as build state" → Schema, for the source of truth these table
// definitions mirror verbatim.

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS intents (
  id          TEXT PRIMARY KEY,
  goal        TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 100,
  status      TEXT NOT NULL DEFAULT 'proposed'
              CHECK (status IN ('proposed','planned','active','complete')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS requirements (
  id          TEXT PRIMARY KEY,
  intent_id   TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('rule','constraint','acceptance')),
  statement   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intent_dependencies (
  intent_id            TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  depends_on_intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  PRIMARY KEY (intent_id, depends_on_intent_id),
  CHECK (intent_id <> depends_on_intent_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  intent_id      TEXT NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  module         TEXT NOT NULL,
  layer          TEXT NOT NULL,
  objective      TEXT NOT NULL,
  scope_globs    TEXT NOT NULL,
  verify_command TEXT NOT NULL,
  commit_message TEXT NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 100,
  exclusive      INTEGER NOT NULL DEFAULT 0,
  verify_radius  TEXT,
  -- Every value here is one the engine actually writes. A CHECK listing
  -- states nothing can produce documents a lifecycle that doesn't exist
  -- and invites writing one the engine can't handle.
  status         TEXT NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed','planned','ready','building',
                                   'verifying','complete','blocked')),
  blocked_reason TEXT CHECK (blocked_reason IS NULL OR blocked_reason IN
                   ('scope_violation','verification_failed','lease_expired')),
  lease_owner      TEXT,
  lease_expires_at TEXT,
  leased_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((lease_owner IS NULL) = (status NOT IN ('building','verifying')))
);

CREATE TABLE IF NOT EXISTS task_requirements (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, requirement_id)
);

CREATE TABLE IF NOT EXISTS dependencies (
  task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id        INTEGER PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('created','modified')),
  commit_sha TEXT
);

CREATE TABLE IF NOT EXISTS verifications (
  id         INTEGER PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  command    TEXT NOT NULL,
  exit_code  INTEGER,
  output     TEXT,
  status     TEXT NOT NULL CHECK (status IN ('passed','failed')),
  ran_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Declared debt: a note one task leaves for the tasks that inherit from
-- it. A layer that discovers a real limitation has nowhere else to put
-- it — a "KNOWN LIMITATION" comment in a source file is not a mechanism,
-- because the task that inherits the problem never reads that file's
-- comments before building. Rows here are rendered into the packet of
-- every task that (transitively) depends on task_id, so the limitation
-- travels down the chain the same way the dependency does.
CREATE TABLE IF NOT EXISTS debt (
  id        INTEGER PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  note      TEXT NOT NULL,
  logged_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS friction (
  id        INTEGER PRIMARY KEY,
  task_id   TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  note      TEXT NOT NULL,
  logged_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Applies the schema to an already-open node:sqlite DatabaseSync instance.
// Idempotent: safe to call against a DB that already has these tables.
export function applySchema(db) {
  db.exec(SCHEMA_SQL);
}
