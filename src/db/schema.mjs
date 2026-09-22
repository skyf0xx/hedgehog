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
  -- JSON map of path → content fingerprint for every path the working
  -- tree was already dirty at the instant this task was claimed. Part of
  -- the lease (written by claim, cleared with the lease), and read by
  -- verify's scope gate so a path that has not changed since the claim is
  -- never attributed to this task. NULL means "no snapshot" — the gate
  -- then falls back to attributing the whole dirty tree, its pre-snapshot
  -- behaviour.
  claim_snapshot   TEXT,
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
  id               INTEGER PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  note             TEXT NOT NULL,
  logged_at        TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at      TEXT,
  resolved_reason  TEXT
);

-- Declared decision: a note one task leaves for the tasks that inherit
-- from it, delivered the same way debt is (rendered into every dependent
-- task's packet) but for a different purpose. Debt records what's still
-- wrong with a task; a decision records why it was built the way it was
-- — the pattern, library, or trade-off chosen. Without it, that
-- reasoning lives only in the agent session that made the choice, and a
-- dependent task built by a different, isolated session has no way to
-- learn it beyond reading the diff and guessing.
CREATE TABLE IF NOT EXISTS decisions (
  id        INTEGER PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  note      TEXT NOT NULL,
  logged_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS friction (
  id               INTEGER PRIMARY KEY,
  task_id          TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  note             TEXT NOT NULL,
  logged_at        TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at      TEXT,
  resolved_reason  TEXT
);
`;

// Columns added to `tasks` after the first schema shipped. `CREATE TABLE
// IF NOT EXISTS` above is a no-op against a DB created by an earlier
// version, so a new column has to be ALTERed in explicitly or every
// statement naming it fails on that DB. Each entry is `[name, ddl]`.
//
// The lease columns (lease_owner, lease_expires_at, leased_at) and their
// siblings (exclusive, verify_radius, blocked_reason) shipped together in
// the same commit that introduced them to SCHEMA_SQL above, but were
// never added here — so a graph created before that commit still lacks
// them today, with every query naming lease_owner failing "no such
// column" instead of self-healing the way claim_snapshot already does.
const TASK_COLUMN_MIGRATIONS = [
  ['exclusive', 'exclusive INTEGER NOT NULL DEFAULT 0'],
  ['verify_radius', 'verify_radius TEXT'],
  [
    'blocked_reason',
    "blocked_reason TEXT CHECK (blocked_reason IS NULL OR blocked_reason IN ('scope_violation','verification_failed','lease_expired'))",
  ],
  ['lease_owner', 'lease_owner TEXT'],
  ['lease_expires_at', 'lease_expires_at TEXT'],
  ['leased_at', 'leased_at TEXT'],
  ['claim_snapshot', 'claim_snapshot TEXT'],
];

// Brings an already-created `tasks` table up to the current column set.
// Idempotent and cheap (one PRAGMA), so callers that must not fail on a
// missing column — claim, which writes the snapshot, and verify, which
// clears it — can just call it before they touch the table. Requires a
// writable handle; read-only commands never need it, since a missing
// column only ever reads back as undefined.
export function ensureTaskColumns(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name));
  for (const [name, ddl] of TASK_COLUMN_MIGRATIONS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${ddl}`);
  }
}

// Schema version this installed CLI knows about, tracked in the graph's
// own `PRAGMA user_version` (an integer SQLite stores in the file header
// — no table required, so it reads back even on a brand-new file).
// Bumped by one for every entry added to MIGRATIONS below; never
// hand-set past what MIGRATIONS actually covers, since runMigrations
// trusts this number to mean "every migration through this version has
// run."
export const CURRENT_SCHEMA_VERSION = 4;

// Forward migrations, applied in order to bring a graph's user_version up
// to CURRENT_SCHEMA_VERSION. Unlike the CREATE TABLE IF NOT EXISTS /
// ensureTaskColumns pair above — which only ever reconciles present-day
// shape against however old a graph is, and can't touch anything already
// baked into an existing column (a CHECK constraint, a rename, a data
// transform) — this is versioned, so a future change too structural for
// a bare ADD COLUMN has somewhere to go, and upgrading is one fail-loud
// step instead of every command's queries silently assuming a shape
// that might not be there yet.
const MIGRATIONS = [
  {
    version: 1,
    // The lease/task columns TASK_COLUMN_MIGRATIONS covers already had to
    // be idempotent against a fresh CREATE TABLE (which includes them
    // from the start) — ensureTaskColumns' own presence check already
    // does exactly what a migration step needs.
    migrate: (db) => ensureTaskColumns(db),
  },
  {
    version: 2,
    migrate: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS decisions (
          id        INTEGER PRIMARY KEY,
          task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          note      TEXT NOT NULL,
          logged_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 3,
    // A `debt` row with no `resolved_at` reads back as unresolved, so an
    // existing graph's rows default to open the moment this column exists.
    migrate: (db) => {
      const existing = new Set(db.prepare('PRAGMA table_info(debt)').all().map((row) => row.name));
      if (!existing.has('resolved_at')) db.exec('ALTER TABLE debt ADD COLUMN resolved_at TEXT');
      if (!existing.has('resolved_reason')) {
        db.exec('ALTER TABLE debt ADD COLUMN resolved_reason TEXT');
      }
    },
  },
  {
    version: 4,
    // Same shape as version 3's debt columns, for friction — an existing
    // graph's rows default to open the moment these columns exist.
    migrate: (db) => {
      const existing = new Set(db.prepare('PRAGMA table_info(friction)').all().map((row) => row.name));
      if (!existing.has('resolved_at')) db.exec('ALTER TABLE friction ADD COLUMN resolved_at TEXT');
      if (!existing.has('resolved_reason')) {
        db.exec('ALTER TABLE friction ADD COLUMN resolved_reason TEXT');
      }
    },
  },
];

// Brings a graph's `PRAGMA user_version` up to CURRENT_SCHEMA_VERSION,
// running only the migrations it hasn't seen yet. A graph newer than
// this installed CLI knows about (its user_version already ahead of
// CURRENT_SCHEMA_VERSION — created by, or migrated with, a later
// Hedgehog) fails loudly here with a plain-English fix, instead of every
// later query failing confusingly on a column or table shape this code
// has never heard of.
export function runMigrations(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();

  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `This build graph was created by a newer version of Hedgehog (schema v${current}) than the one installed here (schema v${CURRENT_SCHEMA_VERSION}). Upgrade Hedgehog (\`npx @skyf0xx/hedgehog@latest update\`) before running commands against this graph.`,
    );
  }

  for (const { version, migrate } of MIGRATIONS) {
    if (version > current) {
      migrate(db);
      db.exec(`PRAGMA user_version = ${version}`);
    }
  }
}

// Applies the schema to an already-open node:sqlite DatabaseSync instance,
// then brings it up to CURRENT_SCHEMA_VERSION. Idempotent: safe to call
// against a DB that already has these tables and has already migrated.
export function applySchema(db) {
  db.exec(SCHEMA_SQL);
  runMigrations(db);
}
