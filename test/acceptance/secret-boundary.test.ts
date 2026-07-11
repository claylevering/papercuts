/**
 * Release-blocking secret-boundary acceptance suite (plan Task 7 Step 1).
 *
 * Black-box contract: every supported secret class from
 * `src/security/redactor.ts` is submitted through the real CLI (spawned as a
 * subprocess, stdin capture path) and must never reach any observable surface
 * in raw form:
 *
 *   - process stdout/stderr of every spawned command
 *   - rows queried straight out of SQLite (read-only `bun:sqlite` connection)
 *   - raw bytes of the database, `-wal`, and `-shm` files
 *   - `papercuts doctor` output
 *   - the Markdown export
 *
 * Vacuity guard: each class must leave its `[REDACTED:...]` marker in the
 * queried body (with an exact `[REDACTED:CREDENTIAL]` count of three, one per
 * credential-prefix family), and each byte-scan surface must contain a benign
 * sentinel proving the scan actually read record content.
 *
 * All canaries are synthetic, constructed by concatenation at runtime.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRYPOINT = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const BUN_EXECUTABLE = process.execPath;

/** Unique per run so a stale database or cached output can never satisfy us. */
const nonce = crypto.randomUUID().replaceAll("-", "");

/**
 * Distinctive secret payloads, one per redactor class / credential family.
 * Lowercase alphanumerics only, so even a surface that lowercases text (tag
 * normalization) could not hide a leak from the byte-for-byte search.
 */
const rawCanaries: Record<string, string> = {
  authorizationHeader: "authcanary" + nonce,
  cookieValue: "cookiecanary" + nonce,
  privateKeyBlock: "pkcanary" + nonce,
  urlCredential: "urlcanary" + nonce,
  secretAssignment: "secretcanary" + nonce,
  ghFamilyCredential: "ghcanary" + nonce, // ghp_ prefix family
  skFamilyCredential: "skcanary" + nonce, // sk- prefix family
  xoxFamilyCredential: "xoxcanary" + nonce, // xox*- prefix family
  ghFamilySecondBody: "ghocanary" + nonce, // gho_ credential in record two
  modelMetadata: "modelcanary" + nonce, // sk- credential passed via --model
  categoryMetadata: "catcanary" + nonce, // xoxs- credential passed via --category
  tagMetadata: "tagcanary" + nonce, // ghp_ credential passed via --tag
};

/** Benign markers that MUST survive, proving each scan surface holds data. */
const sentinelOne = "benignone" + nonce;
const sentinelTwo = "benigntwo" + nonce;

const bodyOne = [
  `While testing I hit friction; benign sentinel ${sentinelOne} stays readable.`,
  `Authorization: Bearer ${rawCanaries["authorizationHeader"]}`,
  `Cookie: session=${rawCanaries["cookieValue"]}`,
  "-----BEGIN RSA PRIVATE KEY-----",
  rawCanaries["privateKeyBlock"],
  "-----END RSA PRIVATE KEY-----",
  `https://user:${rawCanaries["urlCredential"]}@example.test/owner/repo`,
  `API_TOKEN=${rawCanaries["secretAssignment"]}`,
  "ghp_" + rawCanaries["ghFamilyCredential"],
  "sk-" + rawCanaries["skFamilyCredential"],
  "xoxb-" + rawCanaries["xoxFamilyCredential"],
].join("\n");

const bodyTwo = [
  `Second observation with sentinel ${sentinelTwo} for the WAL surface.`,
  "gho_" + rawCanaries["ghFamilySecondBody"],
].join("\n");

const modelOption = "sk-" + rawCanaries["modelMetadata"];
const categoryOption = "xoxs-" + rawCanaries["categoryMetadata"];
const tagOption = "ghp_" + rawCanaries["tagMetadata"];

interface CliResult {
  label: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PapercutRow {
  id: string;
  created_at_ms: number;
  body: string;
  source: string;
  model: string | null;
  category: string | null;
  tags_json: string;
  [column: string]: unknown;
}

interface PipelineState {
  root: string;
  databasePath: string;
  results: CliResult[];
  addOneJson: Record<string, unknown>;
  addTwoResult: CliResult;
  rows: PapercutRow[];
  databaseBytes: Buffer;
  walBytes: Buffer;
  shmBytes: Buffer;
  doctorResult: CliResult;
  exportHumanResult: CliResult;
  exportJson: Record<string, unknown>;
}

let state: PipelineState | null = null;
let holder: Database | null = null;

afterAll(() => {
  holder?.close();
  holder = null;
  if (state !== null) {
    rmSync(state.root, { force: true, recursive: true });
  }
});

async function runCli(
  label: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; stdin?: string },
): Promise<CliResult> {
  const child = Bun.spawn({
    cmd: [BUN_EXECUTABLE, ENTRYPOINT, ...args],
    cwd: options.cwd,
    env: options.env,
    stdin:
      options.stdin === undefined
        ? "ignore"
        : Buffer.from(options.stdin, "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { label, exitCode, stdout, stderr };
}

/** Byte-faithful canary search; latin1 keeps binary bytes 1:1 with chars. */
function findLeaks(haystack: string | Uint8Array): string[] {
  const text =
    typeof haystack === "string"
      ? haystack
      : Buffer.from(haystack).toString("latin1");
  return Object.entries(rawCanaries)
    .filter(([, payload]) => text.includes(payload))
    .map(([name]) => name);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function mustState(): PipelineState {
  if (state === null) {
    throw new Error("Pipeline test did not complete; see its failure first.");
  }
  return state;
}

function parseJsonEnvelope(result: CliResult): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.stdout);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Expected a JSON object from ${result.label}.`);
  }
  return parsed as Record<string, unknown>;
}

describe("secret boundary (release blocker)", () => {
  test(
    "pipeline: capture, pin WAL, and collect every observable surface",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "papercuts-secret-")));
      const papercutsHome = join(root, "data"); // must not pre-exist
      const fakeHome = join(root, "home");
      const workDir = join(root, "work"); // deliberately not a Git repository
      mkdirSync(fakeHome, { recursive: true });
      mkdirSync(workDir, { recursive: true });

      const env: Record<string, string> = {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: fakeHome,
        PAPERCUTS_HOME: papercutsHome,
      };
      const databasePath = join(papercutsHome, "papercuts.sqlite3");
      const results: CliResult[] = [];

      // 1. First capture: every redactor class in one stdin body (JSON mode).
      const addOne = await runCli(
        "add-one",
        ["add", "--stdin", "--json", "--source", "claude-code"],
        { cwd: workDir, env, stdin: bodyOne },
      );
      results.push(addOne);
      expect(addOne.exitCode).toBe(0);
      expect(existsSync(databasePath)).toBe(true);

      // 2. Checkpoint record one into the main database file so the main-db
      //    byte scan is provably non-vacuous, then keep this connection open
      //    to pin the fresh WAL (which will then hold only record two).
      holder = new Database(databasePath, { create: false, readwrite: true });
      holder.run("PRAGMA wal_checkpoint(TRUNCATE)");
      holder.query("SELECT COUNT(*) AS n FROM papercuts").get();

      // 3. Second capture (human mode): canaries in body, model, category, tag.
      const addTwo = await runCli(
        "add-two",
        [
          "add",
          "--stdin",
          "--source",
          "generic",
          "--model",
          modelOption,
          "--category",
          categoryOption,
          "--tag",
          tagOption,
        ],
        { cwd: workDir, env, stdin: bodyTwo },
      );
      results.push(addTwo);
      expect(addTwo.exitCode).toBe(0);

      // 4. Raw persistent bytes, captured while the WAL is still pinned.
      expect(existsSync(`${databasePath}-wal`)).toBe(true);
      expect(existsSync(`${databasePath}-shm`)).toBe(true);
      const databaseBytes = readFileSync(databasePath);
      const walBytes = readFileSync(`${databasePath}-wal`);
      const shmBytes = readFileSync(`${databasePath}-shm`);

      // 5. Query every row and column through a read-only connection.
      const readOnly = new Database(databasePath, { readonly: true });
      let rows: PapercutRow[];
      try {
        rows = readOnly
          .query<PapercutRow, []>(
            "SELECT * FROM papercuts ORDER BY created_at_ms ASC, id ASC",
          )
          .all();
      } finally {
        readOnly.close();
      }

      // 6. Diagnostics and export surfaces via fresh CLI processes.
      const doctorResult = await runCli("doctor", ["doctor", "--json"], {
        cwd: workDir,
        env,
      });
      results.push(doctorResult);
      const exportHumanResult = await runCli("export-human", ["export"], {
        cwd: workDir,
        env,
      });
      results.push(exportHumanResult);
      const exportJsonResult = await runCli(
        "export-json",
        ["export", "--json"],
        { cwd: workDir, env },
      );
      results.push(exportJsonResult);
      expect(exportHumanResult.exitCode).toBe(0);
      expect(exportJsonResult.exitCode).toBe(0);

      state = {
        root,
        databasePath,
        results,
        addOneJson: parseJsonEnvelope(addOne),
        addTwoResult: addTwo,
        rows,
        databaseBytes,
        walBytes,
        shmBytes,
        doctorResult,
        exportHumanResult,
        exportJson: parseJsonEnvelope(exportJsonResult),
      };
    },
    90_000,
  );

  test("add receipts report redactions but never echo the body", () => {
    const current = mustState();

    const envelope = current.addOneJson;
    expect(envelope["version"]).toBe(1);
    expect(envelope["ok"]).toBe(true);
    expect(envelope["command"]).toBe("add");

    const data = envelope["data"] as Record<string, unknown>;
    // 8 replacements: auth, cookie, private key, URL credential, secret
    // assignment, and one per credential-prefix family (gh*_, sk-, xox*-).
    expect(data["redactionCount"]).toBe(8);
    expect(data["repository"]).toBeNull();
    expect(Object.keys(data).sort()).toEqual([
      "createdAt",
      "id",
      "redactionCount",
      "repository",
      "source",
    ]);

    // Human receipt for record two must not restate any part of the body.
    expect(current.addTwoResult.stdout).not.toContain(sentinelTwo);
    expect(current.addTwoResult.stdout).toContain("Redactions: 4");
  });

  test("queried body carries every expected class marker (non-vacuous)", () => {
    const current = mustState();
    expect(current.rows).toHaveLength(2);

    const first = current.rows[0] as PapercutRow;
    expect(first.body).toContain(sentinelOne);
    expect(first.body).toContain("[REDACTED:AUTHORIZATION]");
    expect(first.body).toContain("[REDACTED:COOKIE]");
    expect(first.body).toContain("[REDACTED:PRIVATE_KEY]");
    expect(first.body).toContain("[REDACTED:URL_CREDENTIAL]");
    expect(first.body).toContain("[REDACTED:SECRET]");
    // Exactly one marker per credential-prefix family: an omitted family
    // matcher shows up here as 2 (and as a raw-canary leak elsewhere).
    expect(countOccurrences(first.body, "[REDACTED:CREDENTIAL]")).toBe(3);

    const second = current.rows[1] as PapercutRow;
    expect(second.body).toContain(sentinelTwo);
    expect(countOccurrences(second.body, "[REDACTED:CREDENTIAL]")).toBe(1);
    expect(second.model).toBe("[REDACTED:CREDENTIAL]");
    expect(second.category).toBe("[REDACTED:CREDENTIAL]");
    // Tags are normalized (trim + lowercase) after screening.
    expect(JSON.parse(second.tags_json)).toEqual(["[redacted:credential]"]);
  });

  test("no raw canary appears in any queried row or column", () => {
    const current = mustState();
    expect(findLeaks(JSON.stringify(current.rows))).toEqual([]);
  });

  test("database, WAL, and SHM bytes contain no raw canary", () => {
    const current = mustState();

    // Non-vacuity: record one was checkpointed into the main database and
    // record two is still sitting in the pinned WAL.
    expect(
      current.databaseBytes.includes(sentinelOne, 0, "latin1"),
    ).toBe(true);
    expect(current.walBytes.includes(sentinelTwo, 0, "latin1")).toBe(true);

    expect(findLeaks(current.databaseBytes)).toEqual([]);
    expect(findLeaks(current.walBytes)).toEqual([]);
    expect(findLeaks(current.shmBytes)).toEqual([]);
  });

  test("doctor output is well-formed and canary-free", () => {
    const current = mustState();

    expect([0, 1]).toContain(current.doctorResult.exitCode);
    const envelope = parseJsonEnvelope(current.doctorResult);
    expect(envelope["version"]).toBe(1);
    expect(envelope["command"]).toBe("doctor");

    expect(findLeaks(current.doctorResult.stdout)).toEqual([]);
    expect(findLeaks(current.doctorResult.stderr)).toEqual([]);
    // Doctor must not surface record bodies either.
    expect(current.doctorResult.stdout).not.toContain(sentinelOne);
    expect(current.doctorResult.stdout).not.toContain(sentinelTwo);
  });

  test("markdown export keeps markers and sentinels but no canaries", () => {
    const current = mustState();

    const markdown = current.exportHumanResult.stdout;
    expect(markdown).toContain(sentinelOne);
    expect(markdown).toContain(sentinelTwo);
    expect(markdown).toContain("[REDACTED:AUTHORIZATION]");
    expect(markdown).toContain("[REDACTED:COOKIE]");
    expect(markdown).toContain("[REDACTED:PRIVATE_KEY]");
    expect(markdown).toContain("[REDACTED:URL_CREDENTIAL]");
    expect(markdown).toContain("[REDACTED:SECRET]");
    expect(markdown).toContain("[REDACTED:CREDENTIAL]");
    expect(findLeaks(markdown)).toEqual([]);

    const data = current.exportJson["data"] as Record<string, unknown>;
    expect(current.exportJson["ok"]).toBe(true);
    expect(data["recordCount"]).toBe(2);
    expect(typeof data["markdown"]).toBe("string");
    expect(findLeaks(data["markdown"] as string)).toEqual([]);
  });

  test("no spawned process wrote a raw canary to stdout or stderr", () => {
    const current = mustState();

    for (const result of current.results) {
      expect({ label: result.label, leaks: findLeaks(result.stdout) }).toEqual({
        label: result.label,
        leaks: [],
      });
      expect({ label: result.label, leaks: findLeaks(result.stderr) }).toEqual({
        label: result.label,
        leaks: [],
      });
    }
  });
});
