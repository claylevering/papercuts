import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { PapercutsError } from "../domain/errors";
import type {
  CaptureSource,
  Papercut,
  PapercutQuery,
  PapercutStore,
  RepoContext,
  RepoKeyKind,
  ScreenedText,
  StoreHealth,
} from "../domain/types";
import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../platform/private-files";
import {
  applyMigrations,
  assertMigrationCompatibility,
} from "./migrations";

export { CURRENT_SCHEMA_VERSION } from "./migrations";

type PapercutRow = {
  id: string;
  created_at_ms: number;
  body: string;
  source: string;
  model: string | null;
  category: string | null;
  tags_json: string;
  client_version: string;
  repo_key: string | null;
  repo_key_kind: string | null;
  repo_name: string | null;
  repo_root: string | null;
  cwd_rel: string | null;
  branch: string | null;
  head: string | null;
  redaction_count: number;
  redaction_version: string;
};

type InsertParameters = {
  id: string;
  createdAtMs: number;
  body: string;
  source: string;
  model: string | null;
  category: string | null;
  tagsJson: string;
  clientVersion: string;
  repoKey: string | null;
  repoKeyKind: string | null;
  repoName: string | null;
  repoRoot: string | null;
  cwdRelative: string | null;
  branch: string | null;
  head: string | null;
  redactionCount: number;
  redactionVersion: string;
};

const INSERT_PAPERCUT_SQL = `INSERT INTO papercuts (
  id,
  created_at_ms,
  body,
  source,
  model,
  category,
  tags_json,
  client_version,
  repo_key,
  repo_key_kind,
  repo_name,
  repo_root,
  cwd_rel,
  branch,
  head,
  redaction_count,
  redaction_version
) VALUES (
  $id,
  $createdAtMs,
  $body,
  $source,
  $model,
  $category,
  $tagsJson,
  $clientVersion,
  $repoKey,
  $repoKeyKind,
  $repoName,
  $repoRoot,
  $cwdRelative,
  $branch,
  $head,
  $redactionCount,
  $redactionVersion
)`;

const SELECT_PAPERCUT_COLUMNS = `SELECT
  id,
  created_at_ms,
  body,
  source,
  model,
  category,
  tags_json,
  client_version,
  repo_key,
  repo_key_kind,
  repo_name,
  repo_root,
  cwd_rel,
  branch,
  head,
  redaction_count,
  redaction_version
FROM papercuts`;

export function openSqliteStore(path: string): PapercutStore {
  ensurePrivateDirectorySync(dirname(path));

  let database: Database | null = null;
  try {
    database = new Database(path, { create: true, strict: true });
    configureConnection(database);
    enforceDatabaseModes(path);
    applyMigrations(database);
    enforceDatabaseModes(path);

    return createStore(database, path);
  } catch (error) {
    database?.close();
    throwSanitizedStoreError(error);
  }
}

function createStore(database: Database, path: string): PapercutStore {
  const insert = database.query<never, InsertParameters>(INSERT_PAPERCUT_SQL);

  return {
    append(record: Papercut): void {
      try {
        insert.run(toInsertParameters(record));
      } catch (error) {
        throwSanitizedStoreError(error);
      } finally {
        enforceDatabaseModes(path);
      }
    },

    list(query: PapercutQuery): readonly Papercut[] {
      try {
        const clauses: string[] = [];
        const parameters: Array<string | number> = [];

        if (query.repoKey !== undefined) {
          clauses.push("repo_key = ?");
          parameters.push(query.repoKey);
        }
        if (query.sinceMs !== undefined) {
          clauses.push("created_at_ms >= ?");
          parameters.push(query.sinceMs);
        }

        const direction = query.order === "newest" ? "DESC" : "ASC";
        let sql = SELECT_PAPERCUT_COLUMNS;
        if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
        sql += ` ORDER BY created_at_ms ${direction}, id ${direction}`;
        if (query.limit !== undefined) {
          sql += " LIMIT ?";
          parameters.push(query.limit);
        }

        return database
          .query<PapercutRow, Array<string | number>>(sql)
          .all(...parameters)
          .map(rowToPapercut);
      } catch (error) {
        throwSanitizedStoreError(error);
      }
    },

    health(): StoreHealth {
      try {
        const schemaVersion = readSchemaVersion(database);
        const integrityRow = database
          .query<{ integrity: string }, []>(
            "SELECT integrity_check AS integrity FROM pragma_integrity_check",
          )
          .get();
        const versionRow = database
          .query<{ version: string }, []>(
            "SELECT sqlite_version() AS version",
          )
          .get();

        if (integrityRow === null || versionRow === null) {
          throw new PapercutsError("internal_error");
        }

        return {
          schemaVersion,
          integrity: integrityRow.integrity,
          sqliteVersion: versionRow.version,
          lockAvailable: checkWriteLock(database),
        };
      } catch (error) {
        throwSanitizedStoreError(error);
      }
    },

    close(): void {
      try {
        database.close();
      } catch (error) {
        throwSanitizedStoreError(error);
      }
    },
  };
}

function configureConnection(database: Database): void {
  database.run("PRAGMA busy_timeout = 2000");
  assertMigrationCompatibility(database);
  enableWalWithBusyRetry(database);
  database.run("PRAGMA foreign_keys = ON");
  database.run("PRAGMA synchronous = FULL");
  const foreignKeys = database
    .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
    .get();
  const synchronous = database
    .query<{ synchronous: number }, []>("PRAGMA synchronous")
    .get();
  const busyTimeout = database
    .query<{ timeout: number }, []>("PRAGMA busy_timeout")
    .get();

  if (
    foreignKeys?.foreign_keys !== 1 ||
    synchronous?.synchronous !== 2 ||
    busyTimeout?.timeout !== 2_000
  ) {
    throw new PapercutsError("safety_failure");
  }
}

function enableWalWithBusyRetry(database: Database): void {
  const deadline = performance.now() + 2_000;

  while (true) {
    try {
      const journalMode = database
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL")
        .get();

      if (journalMode?.journal_mode.toLowerCase() !== "wal") {
        throw new PapercutsError("safety_failure");
      }
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || performance.now() >= deadline) throw error;
      Bun.sleepSync(10);
    }
  }
}

function readSchemaVersion(database: Database): number {
  const row = database
    .query<{ version: number | null }, []>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    )
    .get();

  return row?.version ?? 0;
}

function checkWriteLock(database: Database): boolean {
  const check = database.transaction(() => undefined);
  try {
    check.immediate();
    return true;
  } catch (error) {
    if (isSqliteBusy(error)) return false;
    throw error;
  }
}

function toInsertParameters(record: Papercut): InsertParameters {
  return {
    id: record.id,
    createdAtMs: record.createdAtMs,
    body: record.body,
    source: record.source,
    model: record.model,
    category: record.category,
    tagsJson: JSON.stringify(record.tags),
    clientVersion: record.clientVersion,
    repoKey: record.repo?.key ?? null,
    repoKeyKind: record.repo?.keyKind ?? null,
    repoName: record.repo?.displayName ?? null,
    repoRoot: record.repo?.root ?? null,
    cwdRelative: record.repo?.cwdRelative ?? null,
    branch: record.repo?.branch ?? null,
    head: record.repo?.head ?? null,
    redactionCount: record.redactionCount,
    redactionVersion: record.redactionVersion,
  };
}

function rowToPapercut(row: PapercutRow): Papercut {
  const parsedTags: unknown = JSON.parse(row.tags_json);
  if (
    !Array.isArray(parsedTags) ||
    parsedTags.some((tag) => typeof tag !== "string")
  ) {
    throw new PapercutsError("internal_error");
  }

  let repo: RepoContext | null = null;
  if (row.repo_key !== null) {
    if (
      row.repo_key_kind === null ||
      row.repo_name === null ||
      row.repo_root === null ||
      row.cwd_rel === null
    ) {
      throw new PapercutsError("internal_error");
    }

    repo = {
      key: row.repo_key,
      keyKind: row.repo_key_kind as RepoKeyKind,
      displayName: row.repo_name as ScreenedText,
      root: row.repo_root as ScreenedText,
      cwdRelative: row.cwd_rel as ScreenedText,
      branch: row.branch as ScreenedText | null,
      head: row.head as ScreenedText | null,
    };
  }

  return {
    id: row.id,
    createdAtMs: row.created_at_ms,
    body: row.body as ScreenedText,
    source: row.source as CaptureSource,
    model: row.model as ScreenedText | null,
    category: row.category as ScreenedText | null,
    tags: parsedTags as ScreenedText[],
    clientVersion: row.client_version,
    repo,
    redactionCount: row.redaction_count,
    redactionVersion: row.redaction_version,
  };
}

function enforceDatabaseModes(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) ensurePrivateFileSync(candidate);
  }
}

function throwSanitizedStoreError(error: unknown): never {
  if (error instanceof PapercutsError) throw error;
  if (isSqliteBusy(error)) throw new PapercutsError("store_busy");
  throw new PapercutsError("internal_error");
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;

  const code = String((error as Error & { code?: unknown }).code);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}
