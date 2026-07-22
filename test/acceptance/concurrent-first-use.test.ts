import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CURRENT_SCHEMA_VERSION } from "../../src/storage/migrations";

/**
 * Black-box concurrency gate (plan Task 7, Step 2 / design release gate 2).
 *
 * Fifty independent CLI processes race to record one papercut each into a
 * single, initially NONEXISTENT `PAPERCUTS_HOME`. We spawn the real entrypoint
 * as a subprocess (`bun src/index.ts …`) — never an in-process import — so the
 * first-use file-creation race, the WAL setup, migrations, and the busy
 * handling are all exercised exactly as a shipped invocation would exercise
 * them. Every process gets the same fresh temp home and a non-Git working
 * directory, so records are unscoped and deterministic.
 *
 * The gate asserts: all fifty records persist (no loss, no partial write, no
 * duplicate body), the schema is current, database/WAL/SHM are owner-only
 * `0600` with a `0700` data directory, `PRAGMA integrity_check` returns "ok",
 * and no invocation ever leaks an unhandled busy error onto stderr. A busy
 * outcome, if the CLI surfaces one, must be the design's *handled* retryable
 * `store_busy` (JSON on stdout, exit 5, stderr empty); the test retries only
 * those specific bodies and still requires a final count of exactly fifty.
 */

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const INDEX = join(REPO_ROOT, "src", "index.ts");
const RECORD_COUNT = 50;
/** Bounded retry budget per body that surfaced a handled `store_busy`. */
const MAX_RETRY_ATTEMPTS = 8;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

let parentTmp: string;
let dataHome: string;
let nonGitCwd: string;

beforeAll(() => {
  // The PARENT exists; `dataHome` itself does not — the fifty processes must
  // create it (and the database, WAL, and SHM inside it) under contention.
  parentTmp = mkdtempSync(join(tmpdir(), "papercuts-concurrent-"));
  dataHome = join(parentTmp, "papercuts-home-does-not-exist-yet");
  nonGitCwd = mkdtempSync(join(tmpdir(), "papercuts-concurrent-nongit-"));
});

afterAll(() => {
  rmSync(parentTmp, { recursive: true, force: true });
  rmSync(nonGitCwd, { recursive: true, force: true });
});

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function asObject(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

/** Spawn `bun src/index.ts <args>` against the shared temp home. */
async function runCli(
  args: readonly string[],
  stdin?: string,
): Promise<CliResult> {
  const child = Bun.spawn(["bun", INDEX, ...args], {
    cwd: nonGitCwd,
    // Override PAPERCUTS_HOME AFTER the spread so the real default store at
    // ~/Library/Application Support/papercuts is never touched.
    env: { ...process.env, PAPERCUTS_HOME: dataHome },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  let json: unknown = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { code, stdout, stderr, json };
}

function runAdd(body: string): Promise<CliResult> {
  return runCli(["add", "--stdin", "--source", "generic", "--json"], body);
}

type Classified =
  | { kind: "ok" }
  | { kind: "busy" }
  | { kind: "unexpected"; detail: string };

/** Split one add outcome into success / handled-busy / hard-failure. */
function classifyAdd(body: string, result: CliResult): Classified {
  // JSON mode routes every handled error to stdout; stderr must stay empty.
  // A non-empty stderr is precisely the "unhandled busy error" the gate forbids.
  if (result.stderr !== "") {
    return {
      kind: "unexpected",
      detail: `stderr not empty for "${body}": ${JSON.stringify(result.stderr)}`,
    };
  }

  if (
    result.code === 0 &&
    isEnvelope(result.json, { ok: true, command: "add" })
  ) {
    return { kind: "ok" };
  }

  if (
    result.code === 5 &&
    isRetryableBusy(result.json)
  ) {
    return { kind: "busy" };
  }

  return {
    kind: "unexpected",
    detail: `body "${body}": code=${result.code} stdout=${JSON.stringify(result.stdout)}`,
  };
}

function isEnvelope(
  json: unknown,
  fields: { ok: boolean; command: string },
): boolean {
  if (typeof json !== "object" || json === null) return false;
  const envelope = json as Record<string, unknown>;
  return (
    envelope["version"] === 1 &&
    envelope["ok"] === fields.ok &&
    envelope["command"] === fields.command
  );
}

function isRetryableBusy(json: unknown): boolean {
  if (!isEnvelope(json, { ok: false, command: "add" })) return false;
  const error = (json as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return false;
  const details = error as Record<string, unknown>;
  return details["code"] === "store_busy" && details["retryable"] === true;
}

test(
  "fifty concurrent first-use captures all persist with an intact owner-only store",
  async () => {
    // Guard: never operate on anything but a fresh throwaway temp home.
    expect(dataHome).toContain("papercuts-home-does-not-exist-yet");
    expect(existsSync(dataHome)).toBe(false);

    const bodies = Array.from(
      { length: RECORD_COUNT },
      (_, index) => `concurrent-first-use record ${index + 1}`,
    );

    // Wave one: all fifty at once against the nonexistent home.
    const results = await Promise.all(bodies.map(runAdd));

    const busyBodies: string[] = [];
    const unexpected: string[] = [];
    const persisted = new Set<string>();

    results.forEach((result, index) => {
      const body = bodies[index]!;
      const outcome = classifyAdd(body, result);
      if (outcome.kind === "ok") {
        persisted.add(body);
      } else if (outcome.kind === "busy") {
        busyBodies.push(body);
      } else {
        unexpected.push(outcome.detail);
      }
    });

    // No process may crash or emit anything to stderr.
    expect(unexpected).toEqual([]);

    // Retry ONLY the bodies whose write was refused with a handled, retryable
    // busy. Contention is gone once wave one has drained, so sequential retries
    // succeed quickly; a lost record would leave `persisted` short of fifty.
    for (const body of busyBodies) {
      let recorded = false;
      for (
        let attempt = 0;
        attempt < MAX_RETRY_ATTEMPTS && !recorded;
        attempt += 1
      ) {
        const retry = await runAdd(body);
        const outcome = classifyAdd(body, retry);
        expect(outcome).not.toMatchObject({ kind: "unexpected" });
        if (outcome.kind === "ok") {
          persisted.add(body);
          recorded = true;
        }
      }
      expect(recorded).toBe(true);
    }

    // Exactly the fifty distinct bodies were accepted.
    expect(persisted.size).toBe(RECORD_COUNT);
    expect([...persisted].sort()).toEqual([...bodies].sort());

    // --- File-mode gate (checked before any in-test DB open) ---
    const databasePath = join(dataHome, "papercuts.sqlite3");
    const walPath = `${databasePath}-wal`;
    const shmPath = `${databasePath}-shm`;

    expect(existsSync(databasePath)).toBe(true);
    expect(existsSync(walPath)).toBe(true);
    expect(existsSync(shmPath)).toBe(true);

    expect(fileMode(dataHome)).toBe(0o700);
    expect(fileMode(databasePath)).toBe(0o600);
    expect(fileMode(walPath)).toBe(0o600);
    expect(fileMode(shmPath)).toBe(0o600);

    // --- Durable-store gate (direct read of the resulting database bytes) ---
    const database = new Database(databasePath, { readonly: true });
    try {
      const count = asObject(
        database.query("SELECT COUNT(*) AS total FROM papercuts").get(),
      )["total"];
      expect(count).toBe(RECORD_COUNT);

      const schemaVersion = asObject(
        database
          .query("SELECT MAX(version) AS version FROM schema_migrations")
          .get(),
      )["version"];
      expect(schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

      const integrity = asObject(
        database.query("PRAGMA integrity_check").get(),
      )["integrity_check"];
      expect(integrity).toBe("ok");

      const storedBodies = database
        .query("SELECT body FROM papercuts")
        .all()
        .map((row) => asObject(row)["body"])
        .sort();
      expect(storedBodies).toEqual([...bodies].sort());
    } finally {
      database.close();
    }

    // --- Black-box read-back through a fresh CLI process ---
    const list = await runCli(["list", "--repo", "all", "--json"]);
    expect(list.stderr).toBe("");
    expect(list.code).toBe(0);
    expect(isEnvelope(list.json, { ok: true, command: "list" })).toBe(true);

    const data = asObject(asObject(list.json)["data"]);
    const records = data["records"];
    expect(Array.isArray(records)).toBe(true);
    const listBodies = (records as Array<Record<string, unknown>>)
      .map((record) => record["body"])
      .sort();
    expect(listBodies).toEqual([...bodies].sort());
  },
  120_000,
);
