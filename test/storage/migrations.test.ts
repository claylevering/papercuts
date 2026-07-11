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
import type { Papercut, PapercutStore } from "../../src/domain/types";
import { redact } from "../../src/security/redactor";
import { CURRENT_SCHEMA_VERSION } from "../../src/storage/migrations";
import { openSqliteStore } from "../../src/storage/sqlite-store";

type MigrationRow = {
  version: number;
  name: string;
  checksum: string;
  appliedAtMs: number;
};

describe("SQLite migrations and safety", () => {
  let directory: string;
  let databasePath: string;
  const stores: PapercutStore[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "papercuts-migrations-"));
    databasePath = join(directory, "papercuts.sqlite3");
  });

  afterEach(() => {
    for (const store of stores.splice(0).reverse()) store.close();
    rmSync(directory, { force: true, recursive: true });
  });

  test("persists the migration checksum and reopens idempotently", () => {
    openStore().close();
    const firstRows = readMigrationRows(databasePath);

    openStore().close();
    const secondRows = readMigrationRows(databasePath);

    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]).toEqual({
      version: CURRENT_SCHEMA_VERSION,
      name: "initial_schema",
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      appliedAtMs: expect.any(Number),
    });
    expect(firstRows[0]?.appliedAtMs).toBeGreaterThan(0);
    expect(secondRows).toEqual(firstRows);
  });

  test("serializes concurrent first-time openers into one migration", async () => {
    const script = `
      import { openSqliteStore } from "./src/storage/sqlite-store.ts";
      await Bun.sleep(25);
      const store = openSqliteStore(process.env.PAPERCUTS_TEST_DATABASE_PATH!);
      await Bun.sleep(50);
      store.close();
    `;
    const workers = Array.from({ length: 2 }, () =>
      Bun.spawn(["bun", "-e", script], {
        cwd: process.cwd(),
        env: {
          ...Bun.env,
          PAPERCUTS_TEST_DATABASE_PATH: databasePath,
        },
        stderr: "pipe",
        stdout: "pipe",
      })
    );

    const results = await Promise.all(
      workers.map(async (worker) => ({
        exitCode: await worker.exited,
        stderr: await new Response(worker.stderr).text(),
        stdout: await new Response(worker.stdout).text(),
      })),
    );

    expect(results).toEqual([
      { exitCode: 0, stderr: "", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "" },
    ]);
    expect(readMigrationRows(databasePath)).toHaveLength(1);
  });

  test("upgrades a programmatically created schema-v0 database", () => {
    const fixture = new Database(databasePath, { create: true, strict: true });
    fixture.run("PRAGMA user_version = 0");
    fixture.run("CREATE TABLE legacy_marker (value TEXT NOT NULL) STRICT");
    fixture.query("INSERT INTO legacy_marker (value) VALUES (?)").run("kept");
    fixture.close();

    const store = openStore();

    expect(store.health().schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const inspection = new Database(databasePath, { strict: true });
    try {
      expect(
        inspection
          .query<{ value: string }, []>("SELECT value FROM legacy_marker")
          .get(),
      ).toEqual({ value: "kept" });
      expect(readMigrationRows(databasePath)).toHaveLength(1);
    } finally {
      inspection.close();
    }
  });

  test("refuses a checksum mismatch without mutating schema state", () => {
    openStore().close();
    const fixture = new Database(databasePath, { strict: true });
    fixture
      .query("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
      .run("0".repeat(64));
    fixture.close();
    const before = readLogicalSchemaSnapshot(databasePath);

    const error = captureOpenError(databasePath);

    expect(error).toBeInstanceOf(PapercutsError);
    expect((error as PapercutsError).code).toBe("safety_failure");
    expect(readLogicalSchemaSnapshot(databasePath)).toEqual(before);
  });

  test("refuses a future schema without mutating schema state", () => {
    const fixture = new Database(databasePath, { create: true, strict: true });
    fixture.run(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms > 0)
    ) STRICT`);
    fixture.run("CREATE TABLE future_marker (value TEXT NOT NULL) STRICT");
    fixture
      .query(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(2, "future_schema", "f".repeat(64), Date.now());
    fixture
      .query("INSERT INTO future_marker (value) VALUES (?)")
      .run("untouched");
    fixture.close();
    const before = readLogicalSchemaSnapshot(databasePath);

    const error = captureOpenError(databasePath);

    expect(error).toBeInstanceOf(PapercutsError);
    expect((error as PapercutsError).code).toBe("safety_failure");
    expect(readLogicalSchemaSnapshot(databasePath)).toEqual(before);
  });

  test("reports a held write lock as unavailable and recovers after rollback", () => {
    const store = openStore();
    const lockHolder = new Database(databasePath, { strict: true });
    lockHolder.run("PRAGMA busy_timeout = 0");

    try {
      lockHolder.run("BEGIN IMMEDIATE");
      expect(store.health().lockAvailable).toBe(false);
      lockHolder.run("ROLLBACK");
      expect(store.health().lockAvailable).toBe(true);
    } finally {
      if (lockHolder.inTransaction) lockHolder.run("ROLLBACK");
      lockHolder.close();
    }
  });

  test("maps lock contention to a sanitized retryable store_busy error", () => {
    const store = openStore();
    const lockHolder = new Database(databasePath, { strict: true });
    const canary = "observation-value-that-must-not-enter-errors";
    lockHolder.run("PRAGMA busy_timeout = 0");

    try {
      lockHolder.run("BEGIN IMMEDIATE");
      const error = captureError(() =>
        store.append(
          makePapercut({
            id: "00000000-0000-4000-8000-000000000902",
            body: redact(canary).text,
          }),
        )
      );

      expect(error).toBeInstanceOf(PapercutsError);
      expect((error as PapercutsError).toJSON()).toEqual({
        code: "store_busy",
        exitCode: 5,
        message: "The papercuts store is busy; try again.",
        retryable: true,
      });
      expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(canary);
      expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(
        "database is locked",
      );
      expect(`${String(error)}${JSON.stringify(error)}`).not.toContain("INSERT");
    } finally {
      if (lockHolder.inTransaction) lockHolder.run("ROLLBACK");
      lockHolder.close();
    }
  });

  test("enforces owner-only modes after WAL initialization and each append", () => {
    chmodSync(directory, 0o755);
    const store = openStore();
    store.append(
      makePapercut({ id: "00000000-0000-4000-8000-000000000903" }),
    );
    const databaseFiles = [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ];
    for (const path of databaseFiles) {
      expect(existsSync(path)).toBe(true);
      chmodSync(path, 0o666);
    }

    store.append(
      makePapercut({ id: "00000000-0000-4000-8000-000000000904" }),
    );

    expect(fileMode(directory)).toBe(0o700);
    for (const path of databaseFiles) expect(fileMode(path)).toBe(0o600);
  });

  function openStore(): PapercutStore {
    const store = openSqliteStore(databasePath);
    stores.push(store);
    return store;
  }
});

function readMigrationRows(path: string): MigrationRow[] {
  const database = new Database(path, { strict: true });
  try {
    return database
      .query<MigrationRow, []>(`SELECT
        version,
        name,
        checksum,
        applied_at_ms AS appliedAtMs
      FROM schema_migrations
      ORDER BY version`)
      .all();
  } finally {
    database.close();
  }
}

function readLogicalSchemaSnapshot(path: string): unknown {
  const database = new Database(path, { strict: true });
  try {
    return {
      migrations: database
        .query<MigrationRow, []>(`SELECT
          version,
          name,
          checksum,
          applied_at_ms AS appliedAtMs
        FROM schema_migrations
        ORDER BY version`)
        .all(),
      schema: database
        .query<{ name: string; sql: string | null; type: string }, []>(
          "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all(),
      userVersion: database
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get(),
    };
  } finally {
    database.close();
  }
}

function captureOpenError(path: string): unknown {
  let opened: PapercutStore | null = null;
  try {
    opened = openSqliteStore(path);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    opened?.close();
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

function makePapercut(overrides: Partial<Papercut> = {}): Papercut {
  return {
    id: "00000000-0000-4000-8000-000000000901",
    createdAtMs: 1_750_000_000_000,
    body: redact("A migration safety observation.").text,
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
