import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PapercutsError } from "../../src/domain/errors";
import type {
  Papercut,
  PapercutStore,
  RepoContext,
} from "../../src/domain/types";
import { redact } from "../../src/security/redactor";
import {
  CURRENT_SCHEMA_VERSION,
  openSqliteStore,
} from "../../src/storage/sqlite-store";

describe("openSqliteStore", () => {
  let directory: string;
  let databasePath: string;
  let store: PapercutStore | null;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "papercuts-store-"));
    databasePath = join(directory, "papercuts.sqlite3");
    store = null;
  });

  afterEach(() => {
    store?.close();
    rmSync(directory, { force: true, recursive: true });
  });

  test("creates the strict current schema and required indexes", () => {
    store = openSqliteStore(databasePath);

    const inspection = new Database(databasePath, { strict: true });
    try {
      const tables = inspection
        .query<{ name: string; strict: number }, []>(
          "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      const indexes = inspection
        .query<{ name: string; sql: string }, []>(
          "SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      const tableSql = inspection
        .query<{ name: string; sql: string }, []>(
          "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      const migrationColumns = inspection
        .query<TableColumn, []>("PRAGMA table_xinfo('schema_migrations')")
        .all();
      const papercutColumns = inspection
        .query<TableColumn, []>("PRAGMA table_xinfo('papercuts')")
        .all();
      const journalMode = inspection
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
        .get();

      expect(tables).toEqual([
        { name: "papercuts", strict: 1 },
        { name: "schema_migrations", strict: 1 },
      ]);
      expect(indexes).toEqual([
        {
          name: "papercuts_active_created_idx",
          sql: "CREATE INDEX papercuts_active_created_idx\n  ON papercuts(created_at_ms DESC, id DESC)\n  WHERE resolved_at_ms IS NULL",
        },
        {
          name: "papercuts_created_idx",
          sql: "CREATE INDEX papercuts_created_idx\n  ON papercuts(created_at_ms DESC, id DESC)",
        },
        {
          name: "papercuts_repo_created_idx",
          sql: "CREATE INDEX papercuts_repo_created_idx\n  ON papercuts(repo_key, created_at_ms DESC, id DESC)\n  WHERE repo_key IS NOT NULL",
        },
      ]);
      expect(tableSql).toEqual(EXPECTED_TABLE_SQL);
      expect(migrationColumns).toEqual(EXPECTED_MIGRATION_COLUMNS);
      expect(papercutColumns).toEqual(EXPECTED_PAPERCUT_COLUMNS);
      expect(journalMode).toEqual({ journal_mode: "wal" });
    } finally {
      inspection.close();
    }
  });

  test("enforces private directory and database modes immediately after open", () => {
    chmodSync(directory, 0o755);

    store = openSqliteStore(databasePath);

    expect(fileMode(directory)).toBe(0o700);
    for (const path of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]) {
      expect(existsSync(path)).toBe(true);
      expect(fileMode(path)).toBe(0o600);
    }
  });

  test("uses strict bindings so missing values cannot silently become null", () => {
    store = openSqliteStore(databasePath);
    const malformed = {
      ...makePapercut({
        id: "00000000-0000-4000-8000-000000000103",
      }),
      model: undefined,
    } as unknown as Papercut;

    const error = captureError(() => store?.append(malformed));

    expect(error).toBeInstanceOf(PapercutsError);
    expect((error as PapercutsError).code).toBe("internal_error");
    expect(store.list({ order: "newest" })).toEqual([]);
  });

  test("appends and lists a complete repository-scoped record", () => {
    store = openSqliteStore(databasePath);
    const record = makePapercut({
      id: "00000000-0000-4000-8000-000000000101",
      body: redact("A complete papercut").text,
      model: redact("model-1").text,
      category: redact("tooling").text,
      tags: [redact("bun").text, redact("sqlite").text],
      repo: makeRepo({
        branch: redact("feature/storage").text,
        head: redact("a".repeat(40)).text,
      }),
      redactionCount: 2,
      redactionVersion: "7",
    });

    store.append(record);

    expect(store.list({ order: "newest" })).toEqual([record]);
  });

  test("round-trips nullable repository and optional metadata", () => {
    store = openSqliteStore(databasePath);
    const record = makePapercut({
      id: "00000000-0000-4000-8000-000000000102",
      model: null,
      category: null,
      tags: [],
      repo: null,
    });

    store.append(record);

    expect(store.list({ order: "oldest" })).toEqual([record]);
  });

  test("hides resolved records by default and restores them on reopen", () => {
    store = openSqliteStore(databasePath);
    const record = makePapercut({
      id: "00000000-0000-4000-8000-000000000103",
    });
    store.append(record);

    expect(store.setResolved(record.id, 1_750_000_000_000)).toBe(true);
    expect(store.list({ order: "newest" })).toEqual([]);
    expect(
      store.list({ order: "newest", includeResolved: true }),
    ).toEqual([record]);
    expect(store.setResolved(record.id, null)).toBe(true);
    expect(store.list({ order: "newest" })).toEqual([record]);
    expect(
      store.setResolved("00000000-0000-4000-8000-000000000104", 1),
    ).toBe(false);
  });

  test("filters by repository and an inclusive since timestamp", () => {
    store = openSqliteStore(databasePath);
    const selectedRepo = makeRepo({ key: "a".repeat(64) });
    const otherRepo = makeRepo({ key: "b".repeat(64) });
    const records = [
      makePapercut({
        id: "00000000-0000-4000-8000-000000000201",
        createdAtMs: 1_000,
        repo: selectedRepo,
      }),
      makePapercut({
        id: "00000000-0000-4000-8000-000000000202",
        createdAtMs: 2_000,
        repo: selectedRepo,
      }),
      makePapercut({
        id: "00000000-0000-4000-8000-000000000203",
        createdAtMs: 3_000,
        repo: selectedRepo,
      }),
      makePapercut({
        id: "00000000-0000-4000-8000-000000000204",
        createdAtMs: 4_000,
        repo: otherRepo,
      }),
    ];
    for (const record of records) store.append(record);

    expect(
      store
        .list({
          order: "oldest",
          repoKey: selectedRepo.key,
          sinceMs: 2_000,
        })
        .map(({ id }) => id),
    ).toEqual([
      "00000000-0000-4000-8000-000000000202",
      "00000000-0000-4000-8000-000000000203",
    ]);
  });

  test("uses id as the stable tie-breaker in both sort directions", () => {
    store = openSqliteStore(databasePath);
    const lowerId = makePapercut({
      id: "00000000-0000-4000-8000-000000000301",
      createdAtMs: 5_000,
    });
    const higherId = makePapercut({
      id: "00000000-0000-4000-8000-000000000302",
      createdAtMs: 5_000,
    });
    store.append(higherId);
    store.append(lowerId);

    expect(store.list({ order: "newest" }).map(({ id }) => id)).toEqual([
      higherId.id,
      lowerId.id,
    ]);
    expect(store.list({ order: "oldest" }).map(({ id }) => id)).toEqual([
      lowerId.id,
      higherId.id,
    ]);
  });

  test("respects the requested result limit after ordering", () => {
    store = openSqliteStore(databasePath);
    for (let index = 1; index <= 4; index += 1) {
      store.append(
        makePapercut({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          createdAtMs: index,
        }),
      );
    }

    expect(
      store.list({ limit: 2, order: "newest" }).map(({ createdAtMs }) =>
        createdAtMs
      ),
    ).toEqual([4, 3]);
  });

  test("reports schema, integrity, SQLite version, and write-lock health", () => {
    store = openSqliteStore(databasePath);

    const health = store.health();

    expect(health).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      integrity: "ok",
      sqliteVersion: expect.any(String),
      lockAvailable: true,
    });
    expect(health.sqliteVersion.length).toBeGreaterThan(0);
  });

  test("rejects malformed core scalars and enums before constructing a record", () => {
    for (const [name, override] of [
      ["non-v4-id", { id: "00000000-0000-1000-8000-000000000001" }],
      ["fractional-time", { created_at_ms: 1.5 }],
      ["unsafe-time", { created_at_ms: Number.MAX_SAFE_INTEGER + 1 }],
      ["non-string-body", { body: 42 }],
      ["empty-body", { body: "" }],
      ["oversized-body", { body: "x".repeat(65_537) }],
      ["unknown-source", { source: "terminal" }],
      ["non-string-client-version", { client_version: 7 }],
      ["empty-client-version", { client_version: "" }],
    ] satisfies ReadonlyArray<readonly [string, Partial<RawPapercutRow>]>) {
      expectTamperedRowRejected(
        join(directory, `${name}.sqlite3`),
        override,
      );
    }
  });

  test("rejects malformed optional metadata and tag payloads", () => {
    for (const [name, override] of [
      ["numeric-model", { model: 7 }],
      ["oversized-model", { model: "é".repeat(129) }],
      ["numeric-category", { category: 7 }],
      ["oversized-category", { category: "é".repeat(33) }],
      ["invalid-tags-json", { tags_json: "not-json" }],
      ["non-array-tags", { tags_json: '{"tag":"sqlite"}' }],
      ["non-string-tag", { tags_json: '["sqlite", 7]' }],
      ["too-many-tags", { tags_json: JSON.stringify(Array(17).fill("x")) }],
      ["empty-tag", { tags_json: '[""]' }],
      ["oversized-tag", { tags_json: JSON.stringify(["é".repeat(33)]) }],
    ] satisfies ReadonlyArray<readonly [string, Partial<RawPapercutRow>]>) {
      expectTamperedRowRejected(
        join(directory, `${name}.sqlite3`),
        override,
      );
    }
  });

  test("rejects malformed repository fields and nullability combinations", () => {
    for (const [name, override] of [
      ["non-hex-key", { repo_key: "z".repeat(64) }],
      ["unknown-key-kind", { repo_key_kind: "mirror" }],
      ["numeric-name", { repo_name: 7 }],
      ["numeric-root", { repo_root: 7 }],
      ["numeric-relative-cwd", { cwd_rel: 7 }],
      ["numeric-branch", { branch: 7 }],
      ["numeric-head", { head: 7 }],
      ["missing-key", { repo_key: null }],
      ["missing-required-name", { repo_name: null }],
      [
        "unscoped-with-branch",
        {
          repo_key: null,
          repo_key_kind: null,
          repo_name: null,
          repo_root: null,
          cwd_rel: null,
          branch: "leaked-branch",
          head: null,
        },
      ],
    ] satisfies ReadonlyArray<readonly [string, Partial<RawPapercutRow>]>) {
      expectTamperedRowRejected(
        join(directory, `${name}.sqlite3`),
        override,
      );
    }
  });

  test("rejects malformed redaction metadata with a fixed sanitized error", () => {
    for (const [name, override] of [
      ["negative-count", { redaction_count: -1 }],
      ["fractional-count", { redaction_count: 1.5 }],
      ["unsafe-count", { redaction_count: Number.MAX_SAFE_INTEGER + 1 }],
      ["non-string-version", { redaction_version: 7 }],
      ["empty-version", { redaction_version: "" }],
    ] satisfies ReadonlyArray<readonly [string, Partial<RawPapercutRow>]>) {
      expectTamperedRowRejected(
        join(directory, `${name}.sqlite3`),
        override,
      );
    }
  });
});

type TableColumn = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
};

const EXPECTED_MIGRATION_COLUMNS: TableColumn[] = [
  { cid: 0, name: "version", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
  { cid: 1, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 2, name: "checksum", type: "TEXT", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 3, name: "applied_at_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
];

const EXPECTED_PAPERCUT_COLUMNS: TableColumn[] = [
  { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1, hidden: 0 },
  { cid: 1, name: "created_at_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 2, name: "body", type: "TEXT", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 3, name: "source", type: "TEXT", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 4, name: "model", type: "TEXT", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 5, name: "category", type: "TEXT", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 6, name: "tags_json", type: "TEXT", notnull: 1, dflt_value: "'[]'", pk: 0, hidden: 0 },
  { cid: 7, name: "client_version", type: "TEXT", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 8, name: "repo_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 9, name: "repo_key_kind", type: "TEXT", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 10, name: "repo_name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 11, name: "repo_root", type: "TEXT", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 12, name: "cwd_rel", type: "TEXT", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 13, name: "branch", type: "TEXT", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 14, name: "head", type: "TEXT", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 15, name: "redaction_count", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 16, name: "redaction_version", type: "TEXT", notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 17, name: "resolved_at_ms", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0, hidden: 0 },
];

const EXPECTED_TABLE_SQL = [
  {
    name: "papercuts",
    sql: `CREATE TABLE papercuts (
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
  redaction_version TEXT NOT NULL, resolved_at_ms INTEGER
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms > 0),
  CHECK (
    (repo_key IS NULL AND repo_key_kind IS NULL AND repo_name IS NULL
      AND repo_root IS NULL AND cwd_rel IS NULL AND branch IS NULL AND head IS NULL)
    OR
    (repo_key IS NOT NULL AND repo_key_kind IS NOT NULL AND repo_name IS NOT NULL
      AND repo_root IS NOT NULL AND cwd_rel IS NOT NULL)
  )
) STRICT`,
  },
  {
    name: "schema_migrations",
    sql: `CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms > 0)
) STRICT`,
  },
];

type RawPapercutRow = {
  id: string | number | null;
  created_at_ms: string | number | null;
  body: string | number | null;
  source: string | number | null;
  model: string | number | null;
  category: string | number | null;
  tags_json: string | number | null;
  client_version: string | number | null;
  repo_key: string | number | null;
  repo_key_kind: string | number | null;
  repo_name: string | number | null;
  repo_root: string | number | null;
  cwd_rel: string | number | null;
  branch: string | number | null;
  head: string | number | null;
  redaction_count: string | number | null;
  redaction_version: string | number | null;
  resolved_at_ms: string | number | null;
};

function expectTamperedRowRejected(
  path: string,
  override: Partial<RawPapercutRow>,
): void {
  createTamperedRowDatabase(path, override);
  const store = openSqliteStore(path);

  try {
    const error = captureError(() => store.list({ order: "newest" }));

    expect(error).toBeInstanceOf(PapercutsError);
    expect((error as PapercutsError).toJSON()).toEqual({
      code: "internal_error",
      exitCode: 1,
      message: "An internal error occurred.",
      retryable: false,
    });
    const tamperedValue = String(Object.values(override)[0]);
    if (tamperedValue.length > 0) {
      expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(
        tamperedValue,
      );
    }
  } finally {
    store.close();
  }
}

function createTamperedRowDatabase(
  path: string,
  override: Partial<RawPapercutRow>,
): void {
  openSqliteStore(path).close();
  const database = new Database(path, { strict: true });

  try {
    database.run("DROP TABLE papercuts");
    database.run(`CREATE TABLE papercuts (
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
      redaction_version,
      resolved_at_ms
    )`);

    const row: RawPapercutRow = {
      id: "00000000-0000-4000-8000-000000000999",
      created_at_ms: 1_750_000_000_000,
      body: "A stored observation.",
      source: "manual",
      model: "model-1",
      category: "tooling",
      tags_json: '["bun","sqlite"]',
      client_version: "0.1.0",
      repo_key: "a".repeat(64),
      repo_key_kind: "remote",
      repo_name: "example/repository",
      repo_root: "/private/example/repository",
      cwd_rel: "packages/cli",
      branch: "feature/storage",
      head: "a".repeat(40),
      redaction_count: 0,
      redaction_version: "1",
      resolved_at_ms: null,
      ...override,
    };
    database
      .query<never, Array<string | number | null>>(`INSERT INTO papercuts (
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
        redaction_version,
        resolved_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id,
        row.created_at_ms,
        row.body,
        row.source,
        row.model,
        row.category,
        row.tags_json,
        row.client_version,
        row.repo_key,
        row.repo_key_kind,
        row.repo_name,
        row.repo_root,
        row.cwd_rel,
        row.branch,
        row.head,
        row.redaction_count,
        row.redaction_version,
        row.resolved_at_ms,
      );
  } finally {
    database.close();
  }
}

function captureError(action: () => void): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function makeRepo(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    key: "a".repeat(64),
    keyKind: "remote",
    displayName: redact("example/repository").text,
    root: redact("/private/example/repository").text,
    cwdRelative: redact("packages/cli").text,
    branch: null,
    head: null,
    ...overrides,
  };
}

function makePapercut(overrides: Partial<Papercut> = {}): Papercut {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    createdAtMs: 1_750_000_000_000,
    body: redact("The command needed an undocumented flag.").text,
    source: "manual",
    model: null,
    category: null,
    tags: [],
    clientVersion: "0.1.0",
    repo: null,
    redactionCount: 0,
    redactionVersion: "1",
    ...overrides,
  };
}
