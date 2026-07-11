import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Standalone-executable gate (plan Task 7, Step 2 / design release gate 5).
 *
 * We compile the CLI ourselves with the exact package.json build flags, but
 * `--outfile` into our OWN temp directory so parallel authors are never racing
 * on the shared `dist/`. The binary is then driven with a fully isolated
 * environment (`env` REPLACES, it does not merge) whose PATH is stripped to
 * `/usr/bin:/bin` — verified to contain neither `bun` nor `node`. That proves
 * the executable carries its own runtime: if it depended on an external Bun or
 * Node it could not launch at all under this PATH.
 *
 * Persistence is proven across FOUR separate binary invocations sharing one
 * external `PAPERCUTS_HOME`: two adds, a list that must observe both, and an
 * export whose Markdown must contain both bodies.
 */

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
/** Exactly the flags from package.json's `build` script. */
const BUILD_FLAGS = [
  "build",
  "--compile",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
] as const;
/** PATH with Bun and Node deliberately absent. */
const STRIPPED_PATH = "/usr/bin:/bin";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

let workDir: string;
let binPath: string;
let nonGitCwd: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "papercuts-compiled-"));
  binPath = join(workDir, "papercuts");
  nonGitCwd = mkdtempSync(join(tmpdir(), "papercuts-compiled-nongit-"));

  const build = Bun.spawnSync(
    [
      "bun",
      ...BUILD_FLAGS,
      "--outfile",
      binPath,
      join(REPO_ROOT, "src", "index.ts"),
    ],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );

  if (build.exitCode !== 0) {
    throw new Error(
      `standalone compile failed (exit ${build.exitCode}): ${build.stderr.toString()}`,
    );
  }
}, 180_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(nonGitCwd, { recursive: true, force: true });
});

function asObject(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
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

/**
 * Run the compiled binary by absolute path under a fully replaced environment:
 * only PATH (stripped), HOME, and the external PAPERCUTS_HOME are visible to
 * the child, so nothing leaks in from the test runner's own environment.
 */
function runBinary(
  args: readonly string[],
  dataHome: string,
  stdin?: string,
): CliResult {
  const result = Bun.spawnSync([binPath, ...args], {
    cwd: nonGitCwd,
    env: { PATH: STRIPPED_PATH, HOME: workDir, PAPERCUTS_HOME: dataHome },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  let json: unknown = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { code: result.exitCode ?? -1, stdout, stderr, json };
}

test("the build produces a standalone executable in our own temp dir", () => {
  expect(existsSync(binPath)).toBe(true);
  const stats = statSync(binPath);
  expect(stats.isFile()).toBe(true);
  // Some execute bit must be set, or the OS could not launch it directly.
  expect(stats.mode & 0o111).not.toBe(0);
});

test("the stripped PATH contains neither bun nor node", () => {
  for (const directory of STRIPPED_PATH.split(":")) {
    expect(existsSync(join(directory, "bun"))).toBe(false);
    expect(existsSync(join(directory, "node"))).toBe(false);
  }
});

test("add/list/export persist across separate isolated binary invocations", () => {
  const dataHome = join(workDir, "external-data-home");
  const databasePath = join(dataHome, "papercuts.sqlite3");
  const bodyAlpha = "compiled-binary persistence alpha record";
  const bodyBeta = "compiled-binary persistence beta record";

  // Guard: the external store must not exist before the first invocation.
  expect(existsSync(databasePath)).toBe(false);

  // --- Invocation 1: record the first papercut ---
  const addAlpha = runBinary(
    ["add", "--stdin", "--source", "generic", "--json"],
    dataHome,
    bodyAlpha,
  );
  expect(addAlpha.stderr).toBe("");
  expect(addAlpha.code).toBe(0);
  expect(isEnvelope(addAlpha.json, { ok: true, command: "add" })).toBe(true);
  const idAlpha = asObject(asObject(addAlpha.json)["data"])["id"];
  expect(typeof idAlpha).toBe("string");

  // The external database was materialized at PAPERCUTS_HOME by the binary.
  expect(existsSync(databasePath)).toBe(true);

  // --- Invocation 2 (a distinct process): record the second papercut ---
  const addBeta = runBinary(
    ["add", "--stdin", "--source", "generic", "--json"],
    dataHome,
    bodyBeta,
  );
  expect(addBeta.stderr).toBe("");
  expect(addBeta.code).toBe(0);
  expect(isEnvelope(addBeta.json, { ok: true, command: "add" })).toBe(true);
  const idBeta = asObject(asObject(addBeta.json)["data"])["id"];
  expect(typeof idBeta).toBe("string");
  expect(idBeta).not.toBe(idAlpha);

  // --- Invocation 3 (a distinct process): list must observe BOTH prior writes ---
  const list = runBinary(["list", "--repo", "all", "--json"], dataHome);
  expect(list.stderr).toBe("");
  expect(list.code).toBe(0);
  expect(isEnvelope(list.json, { ok: true, command: "list" })).toBe(true);

  const records = asObject(asObject(list.json)["data"])["records"];
  expect(Array.isArray(records)).toBe(true);
  const listRows = records as Array<Record<string, unknown>>;
  const listBodies = listRows.map((row) => row["body"]).sort();
  expect(listBodies).toEqual([bodyAlpha, bodyBeta].sort());
  const listIds = listRows.map((row) => row["id"]);
  expect(listIds).toContain(idAlpha);
  expect(listIds).toContain(idBeta);

  // --- Invocation 4 (a distinct process): export both as deterministic Markdown ---
  const exported = runBinary(["export", "--repo", "all", "--json"], dataHome);
  expect(exported.stderr).toBe("");
  expect(exported.code).toBe(0);
  expect(isEnvelope(exported.json, { ok: true, command: "export" })).toBe(true);

  const exportData = asObject(asObject(exported.json)["data"]);
  expect(exportData["recordCount"]).toBe(2);
  const markdown = exportData["markdown"];
  expect(typeof markdown).toBe("string");
  expect(markdown as string).toContain(bodyAlpha);
  expect(markdown as string).toContain(bodyBeta);
});
