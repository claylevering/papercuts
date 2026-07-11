import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
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
    const seeded = openStore();
    seeded.append(
      makePapercut({ id: "00000000-0000-4000-8000-000000000906" }),
    );
    seeded.close();
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

  test("rolls back every migration statement after a deterministic mid-migration failure", () => {
    const fixture = new Database(databasePath, { create: true, strict: true });
    fixture.query("PRAGMA journal_mode = WAL").get();
    fixture.run("CREATE TABLE conflict_target (value TEXT NOT NULL) STRICT");
    fixture.run(
      "CREATE INDEX papercuts_created_idx ON conflict_target(value)",
    );
    fixture.run("CREATE TABLE rollback_marker (value TEXT NOT NULL) STRICT");
    fixture.query("INSERT INTO rollback_marker (value) VALUES (?)").run("kept");
    fixture.close();
    const before = readLogicalSchemaSnapshot(databasePath);

    const error = captureOpenError(databasePath);
    const after = readLogicalSchemaSnapshot(databasePath);

    expect(error).toBeInstanceOf(PapercutsError);
    expect((error as PapercutsError).code).toBe("internal_error");
    expect(withoutFileModes(after)).toEqual(withoutFileModes(before));
    expect(after.files.every(({ mode }) => mode === 0o600)).toBe(true);
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
      const startedAt = performance.now();
      const error = captureError(() =>
        store.append(
          makePapercut({
            id: "00000000-0000-4000-8000-000000000902",
            body: redact(canary).text,
          }),
        )
      );
      const elapsedMs = performance.now() - startedAt;

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
      expect(elapsedMs).toBeGreaterThanOrEqual(1_800);
      expect(elapsedMs).toBeLessThan(3_500);
    } finally {
      if (lockHolder.inTransaction) lockHolder.run("ROLLBACK");
      lockHolder.close();
    }
  });

  test("maps an actual SQLITE_BUSY_SNAPSHOT outcome to store_busy", () => {
    const store = openStore();
    const sqliteError = createBusySnapshotError(
      join(directory, "busy-snapshot.sqlite3"),
    );
    expect((sqliteError as { code?: unknown }).code).toBe(
      "SQLITE_BUSY_SNAPSHOT",
    );

    const error = captureError(() =>
      store.append(recordWhoseTagsThrow(sqliteError))
    );

    expect(error).toBeInstanceOf(PapercutsError);
    expect((error as PapercutsError).toJSON()).toEqual({
      code: "store_busy",
      exitCode: 5,
      message: "The papercuts store is busy; try again.",
      retryable: true,
    });
    expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(
      "database is locked",
    );
  });

  test("maps extended SQLITE_LOCKED families and base errno to store_busy", () => {
    const store = openStore();
    const extendedLocked = Object.assign(new Error("raw locked diagnostic"), {
      code: "SQLITE_LOCKED_SHAREDCACHE",
    });
    const baseBusyErrno = Object.assign(new Error("raw busy diagnostic"), {
      code: "SQLITE_UNKNOWN_EXTENSION",
      errno: 5 | (9 << 8),
    });

    for (const sqliteError of [extendedLocked, baseBusyErrno]) {
      const error = captureError(() =>
        store.append(recordWhoseTagsThrow(sqliteError))
      );

      expect(error).toBeInstanceOf(PapercutsError);
      expect((error as PapercutsError).code).toBe("store_busy");
      expect(`${String(error)}${JSON.stringify(error)}`).not.toContain("raw");
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

  test("sanitizes a failure to create the private data directory", () => {
    const blockedParent = join(directory, "blocked-parent");
    writeFileSync(blockedParent, "not-a-directory", { mode: 0o600 });
    const blockedDatabase = join(blockedParent, "papercuts.sqlite3");

    const error = captureOpenError(blockedDatabase);

    expect(error).toBeInstanceOf(PapercutsError);
    expect((error as PapercutsError).toJSON()).toEqual({
      code: "safety_failure",
      exitCode: 6,
      message: "The operation failed a safety check.",
      retryable: false,
    });
    expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(
      blockedParent,
    );
    expect(`${String(error)}${JSON.stringify(error)}`).not.toContain("EEXIST");
  });

  test("rolls back append when post-write permission enforcement cannot inspect existing files", () => {
    const store = openStore();
    const record = makePapercut({
      id: "00000000-0000-4000-8000-000000000907",
    });
    const databaseFiles = [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ];
    for (const path of databaseFiles) chmodSync(path, 0o666);

    let error: unknown;
    try {
      chmodSync(directory, 0o000);
      error = captureError(() => store.append(record));
    } finally {
      chmodSync(directory, 0o700);
    }

    expect({
      error:
        error instanceof PapercutsError ? error.toJSON() : String(error),
      ids: store.list({ order: "newest" }).map(({ id }) => id),
      modes: databaseFiles.map(fileMode),
    }).toEqual({
      error: {
        code: "safety_failure",
        exitCode: 6,
        message: "The operation failed a safety check.",
        retryable: false,
      },
      ids: [],
      modes: [0o666, 0o666, 0o666],
    });
    expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(
      databasePath,
    );
    expect(`${String(error)}${JSON.stringify(error)}`).not.toContain("EACCES");

    store.append(record);

    expect(store.list({ order: "newest" }).map(({ id }) => id)).toEqual([
      record.id,
    ]);
    expect(databaseFiles.map(fileMode)).toEqual([0o600, 0o600, 0o600]);
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

type DatabaseFileState = {
  name: string;
  mode: number;
  size: number;
  sha256: string;
};

type DatabaseSnapshot = {
  logical: unknown;
  directoryMode: number;
  files: readonly DatabaseFileState[];
};

function readLogicalSchemaSnapshot(path: string): DatabaseSnapshot {
  const database = new Database(path, { strict: true });
  let logicalSnapshot: unknown;
  try {
    const hasMigrations = hasTable(database, "schema_migrations");
    logicalSnapshot = {
      migrations: hasMigrations
        ? database
            .query<MigrationRow, []>(`SELECT
              version,
              name,
              checksum,
              applied_at_ms AS appliedAtMs
            FROM schema_migrations
            ORDER BY version`)
            .all()
        : null,
      schema: database
        .query<{ name: string; sql: string | null; type: string }, []>(
          "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all(),
      journalMode: database
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
        .get(),
      userVersion: database
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get(),
      papercutMarkers: hasTable(database, "papercuts")
        ? database
            .query<{ body: string; id: string }, []>(
              "SELECT id, body FROM papercuts ORDER BY id",
            )
            .all()
        : null,
      futureMarkers: hasTable(database, "future_marker")
        ? database
            .query<{ value: string }, []>(
              "SELECT value FROM future_marker ORDER BY value",
            )
            .all()
        : null,
      rollbackMarkers: hasTable(database, "rollback_marker")
        ? database
            .query<{ value: string }, []>(
              "SELECT value FROM rollback_marker ORDER BY value",
            )
            .all()
        : null,
    };
  } finally {
    database.close();
  }

  return {
    logical: logicalSnapshot,
    directoryMode: fileMode(join(path, "..")),
    files: databaseFileSnapshot(path),
  };
}

function hasTable(database: Database, name: string): boolean {
  return (
    database
      .query<{ present: number }, [string]>(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get(name) !== null
  );
}

function databaseFileSnapshot(path: string): DatabaseFileState[] {
  const directory = join(path, "..");
  const databaseName = path.slice(directory.length + 1);

  return readdirSync(directory)
    .filter(
      (name) => name === databaseName || name.startsWith(`${databaseName}-`),
    )
    .sort()
    .map((name) => {
      const filePath = join(directory, name);
      const bytes = readFileSync(filePath);
      return {
        name,
        mode: fileMode(filePath),
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
}

function withoutFileModes(snapshot: DatabaseSnapshot): unknown {
  return {
    ...snapshot,
    files: snapshot.files.map(({ mode: _mode, ...file }) => file),
  };
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

function createBusySnapshotError(path: string): unknown {
  const reader = new Database(path, { create: true, strict: true });
  const writer = new Database(path, { strict: true });

  try {
    reader.query("PRAGMA journal_mode = WAL").get();
    reader.run("CREATE TABLE snapshot_items (id INTEGER PRIMARY KEY) STRICT");
    reader.run("INSERT INTO snapshot_items DEFAULT VALUES");
    reader.run("BEGIN");
    reader.query("SELECT * FROM snapshot_items").all();
    writer.run("INSERT INTO snapshot_items DEFAULT VALUES");

    return captureError(() =>
      reader.run("INSERT INTO snapshot_items DEFAULT VALUES")
    );
  } finally {
    if (reader.inTransaction) reader.run("ROLLBACK");
    reader.close();
    writer.close();
  }
}

function recordWhoseTagsThrow(error: unknown): Papercut {
  const tags = {
    toJSON(): never {
      throw error;
    },
  } as unknown as Papercut["tags"];

  return makePapercut({
    id: "00000000-0000-4000-8000-000000000905",
    tags,
  });
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
