import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { PapercutsError } from "../domain/errors";

export const CURRENT_SCHEMA_VERSION = 2;

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const INITIAL_SCHEMA_SQL = `CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms > 0)
) STRICT;

CREATE TABLE papercuts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) BETWEEN 1 AND 65536),
  source TEXT NOT NULL CHECK (source IN ('manual','codex','claude-code','generic')),
  model TEXT,
  category TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  client_version TEXT NOT NULL,
  repo_key TEXT CHECK (repo_key IS NULL OR length(repo_key) = 64),
  repo_key_kind TEXT CHECK (repo_key_kind IS NULL OR repo_key_kind IN ('local','remote')),
  repo_name TEXT,
  repo_root TEXT,
  cwd_rel TEXT,
  branch TEXT,
  head TEXT,
  redaction_count INTEGER NOT NULL CHECK (redaction_count >= 0),
  redaction_version TEXT NOT NULL,
  CHECK (
    (repo_key IS NULL AND repo_key_kind IS NULL AND repo_name IS NULL
      AND repo_root IS NULL AND cwd_rel IS NULL AND branch IS NULL AND head IS NULL)
    OR
    (repo_key IS NOT NULL AND repo_key_kind IS NOT NULL AND repo_name IS NOT NULL
      AND repo_root IS NOT NULL AND cwd_rel IS NOT NULL)
  )
) STRICT;

CREATE INDEX papercuts_created_idx
  ON papercuts(created_at_ms DESC, id DESC);
CREATE INDEX papercuts_repo_created_idx
  ON papercuts(repo_key, created_at_ms DESC, id DESC)
  WHERE repo_key IS NOT NULL;`;

const ADD_RESOLUTION_STATE_SQL = `ALTER TABLE papercuts
  ADD COLUMN resolved_at_ms INTEGER
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms > 0);

CREATE INDEX papercuts_active_created_idx
  ON papercuts(created_at_ms DESC, id DESC)
  WHERE resolved_at_ms IS NULL;`;

const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "initial_schema",
    sql: INITIAL_SCHEMA_SQL,
    checksum: sha256Hex(INITIAL_SCHEMA_SQL),
  }),
  Object.freeze({
    version: 2,
    name: "add_resolution_state",
    sql: ADD_RESOLUTION_STATE_SQL,
    checksum: sha256Hex(ADD_RESOLUTION_STATE_SQL),
  }),
]);

type AppliedMigration = {
  version: number;
  name: string;
  checksum: string;
};

export function assertMigrationCompatibility(database: Database): void {
  if (!hasSchemaMigrationsTable(database)) return;

  const applied = readAppliedMigrations(database);
  if (applied.length === 0) {
    throw new PapercutsError("safety_failure");
  }
  validateAppliedMigrations(applied);
}

export function applyMigrations(database: Database): void {
  const migrate = database.transaction(() => {
    const hasMigrationTable = hasSchemaMigrationsTable(database);
    const applied = hasMigrationTable ? readAppliedMigrations(database) : [];

    if (hasMigrationTable && applied.length === 0) {
      throw new PapercutsError("safety_failure");
    }
    validateAppliedMigrations(applied);

    const appliedVersions = new Set(applied.map(({ version }) => version));
    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue;

      database.run(migration.sql);
      database
        .query<never, {
          version: number;
          name: string;
          checksum: string;
          appliedAtMs: number;
        }>(
          `INSERT INTO schema_migrations (
            version,
            name,
            checksum,
            applied_at_ms
          ) VALUES ($version, $name, $checksum, $appliedAtMs)`,
        )
        .run({
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
          appliedAtMs: Date.now(),
        });
    }
  });

  migrate.immediate();
}

function hasSchemaMigrationsTable(database: Database): boolean {
  return (
    database
      .query<{ present: number }, []>(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() !== null
  );
}

function readAppliedMigrations(database: Database): AppliedMigration[] {
  return database
    .query<AppliedMigration, []>(`SELECT
      version,
      name,
      checksum
    FROM schema_migrations
    ORDER BY version`)
    .all();
}

function validateAppliedMigrations(applied: readonly AppliedMigration[]): void {
  for (const row of applied) {
    if (row.version > CURRENT_SCHEMA_VERSION) {
      throw new PapercutsError("safety_failure");
    }

    const expected = MIGRATIONS.find(
      ({ version }) => version === row.version,
    );
    if (
      expected === undefined ||
      row.name !== expected.name ||
      row.checksum !== expected.checksum
    ) {
      throw new PapercutsError("safety_failure");
    }
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
