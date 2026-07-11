import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
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
  id: unknown;
  created_at_ms: unknown;
  body: unknown;
  source: unknown;
  model: unknown;
  category: unknown;
  tags_json: unknown;
  client_version: unknown;
  repo_key: unknown;
  repo_key_kind: unknown;
  repo_name: unknown;
  repo_root: unknown;
  cwd_rel: unknown;
  branch: unknown;
  head: unknown;
  redaction_count: unknown;
  redaction_version: unknown;
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
  let database: Database | null = null;
  try {
    ensurePrivateDirectory(path);
    database = new Database(path, { create: true, strict: true });
    configureConnection(database);
    enforceDatabaseModes(path);
    applyMigrations(database);
    enforceDatabaseModes(path);

    return createStore(database, path);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original fixed error; never expose close diagnostics.
    }
    throwSanitizedStoreError(error);
  }
}

function createStore(database: Database, path: string): PapercutStore {
  const insert = database.query<never, InsertParameters>(INSERT_PAPERCUT_SQL);
  const appendRecord = database.transaction((record: Papercut): void => {
    insert.run(toInsertParameters(record));
    enforceDatabaseModes(path);
  });

  return {
    append(record: Papercut): void {
      try {
        appendRecord.immediate(record);
      } catch (error) {
        throwSanitizedStoreError(error);
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
  const parameters = {
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

  for (const key of Object.keys(parameters) as Array<keyof InsertParameters>) {
    if (parameters[key] === undefined) delete parameters[key];
  }

  return parameters;
}

function rowToPapercut(row: PapercutRow): Papercut {
  const id = requireMatchingString(row.id, UUID_V4_PATTERN);
  const createdAtMs = requireSafeInteger(row.created_at_ms, 1);
  const body = requireBoundedString(row.body, 1, 65_536) as ScreenedText;
  const source = requireCaptureSource(row.source);
  const model = requireNullableBoundedString(row.model, 256);
  const category = requireNullableBoundedString(row.category, 64);
  const tags = parseTags(row.tags_json);
  const clientVersion = requireBoundedString(
    row.client_version,
    1,
    Number.POSITIVE_INFINITY,
  );
  const repo = parseRepo(row);
  const redactionCount = requireSafeInteger(row.redaction_count, 0);
  const redactionVersion = requireBoundedString(
    row.redaction_version,
    1,
    Number.POSITIVE_INFINITY,
  );

  return {
    id,
    createdAtMs,
    body,
    source,
    model: model as ScreenedText | null,
    category: category as ScreenedText | null,
    tags,
    clientVersion,
    repo,
    redactionCount,
    redactionVersion,
  };
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPO_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const CAPTURE_SOURCES: ReadonlySet<string> = new Set([
  "manual",
  "codex",
  "claude-code",
  "generic",
]);
const REPO_KEY_KINDS: ReadonlySet<string> = new Set(["local", "remote"]);

function parseRepo(row: PapercutRow): RepoContext | null {
  const repoValues = [
    row.repo_key,
    row.repo_key_kind,
    row.repo_name,
    row.repo_root,
    row.cwd_rel,
    row.branch,
    row.head,
  ];
  if (repoValues.every((value) => value === null)) return null;

  const key = requireMatchingString(row.repo_key, REPO_KEY_PATTERN);
  const keyKind = requireRepoKeyKind(row.repo_key_kind);
  const displayName = requireString(row.repo_name) as ScreenedText;
  const root = requireString(row.repo_root) as ScreenedText;
  const cwdRelative = requireString(row.cwd_rel) as ScreenedText;
  const branch = requireNullableString(row.branch) as ScreenedText | null;
  const head = requireNullableString(row.head) as ScreenedText | null;

  return {
    key,
    keyKind,
    displayName,
    root,
    cwdRelative,
    branch,
    head,
  };
}

function parseTags(value: unknown): readonly ScreenedText[] {
  const serialized = requireString(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new PapercutsError("internal_error");
  }

  if (!Array.isArray(parsed) || parsed.length > 16) {
    throw new PapercutsError("internal_error");
  }

  return parsed.map(
    (tag) => requireBoundedString(tag, 1, 64) as ScreenedText,
  );
}

function requireCaptureSource(value: unknown): CaptureSource {
  const source = requireString(value);
  if (!CAPTURE_SOURCES.has(source)) {
    throw new PapercutsError("internal_error");
  }
  return source as CaptureSource;
}

function requireRepoKeyKind(value: unknown): RepoKeyKind {
  const keyKind = requireString(value);
  if (!REPO_KEY_KINDS.has(keyKind)) {
    throw new PapercutsError("internal_error");
  }
  return keyKind as RepoKeyKind;
}

function requireSafeInteger(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new PapercutsError("internal_error");
  }
  return value as number;
}

function requireMatchingString(value: unknown, pattern: RegExp): string {
  const text = requireString(value);
  if (!pattern.test(text)) throw new PapercutsError("internal_error");
  return text;
}

function requireNullableBoundedString(
  value: unknown,
  maximumBytes: number,
): string | null {
  if (value === null) return null;
  return requireBoundedString(value, 0, maximumBytes);
}

function requireNullableString(value: unknown): string | null {
  if (value === null) return null;
  return requireString(value);
}

function requireBoundedString(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
): string {
  const text = requireString(value);
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength < minimumBytes || byteLength > maximumBytes) {
    throw new PapercutsError("internal_error");
  }
  return text;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw new PapercutsError("internal_error");
  }
  return value;
}

function enforceDatabaseModes(path: string): void {
  try {
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        lstatSync(candidate);
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw error;
      }
      ensurePrivateFileSync(candidate);
    }
  } catch {
    throw new PapercutsError("safety_failure");
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function ensurePrivateDirectory(path: string): void {
  try {
    ensurePrivateDirectorySync(dirname(path));
  } catch {
    throw new PapercutsError("safety_failure");
  }
}

function throwSanitizedStoreError(error: unknown): never {
  if (error instanceof PapercutsError) throw error;
  if (isSqliteBusy(error)) throw new PapercutsError("store_busy");
  throw new PapercutsError("internal_error");
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  if ("code" in error) {
    const code = String((error as Error & { code?: unknown }).code);
    if (
      code === "SQLITE_BUSY" ||
      code.startsWith("SQLITE_BUSY_") ||
      code === "SQLITE_LOCKED" ||
      code.startsWith("SQLITE_LOCKED_")
    ) {
      return true;
    }
  }

  if (!("errno" in error)) return false;

  const errno = (error as Error & { errno?: unknown }).errno;
  if (typeof errno !== "number" || !Number.isInteger(errno)) return false;

  const primaryResultCode = errno & 0xff;
  return primaryResultCode === 5 || primaryResultCode === 6;
}
