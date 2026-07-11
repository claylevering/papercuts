import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  test("creates the strict v1 schema and required indexes", () => {
    store = openSqliteStore(databasePath);

    const inspection = new Database(databasePath, { strict: true });
    try {
      const tables = inspection
        .query<{ name: string; strict: number }, []>(
          "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      const indexes = inspection
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      const journalMode = inspection
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
        .get();

      expect(tables).toEqual([
        { name: "papercuts", strict: 1 },
        { name: "schema_migrations", strict: 1 },
      ]);
      expect(indexes).toEqual([
        { name: "papercuts_created_idx" },
        { name: "papercuts_repo_created_idx" },
      ]);
      expect(journalMode).toEqual({ journal_mode: "wal" });
    } finally {
      inspection.close();
    }
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
});

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
