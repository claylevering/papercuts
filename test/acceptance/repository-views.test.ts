/**
 * Black-box acceptance tests for repository-scoped reads (Task 7, Step 3, the
 * repository half). Everything here drives the CLI as a real subprocess against
 * real temporary Git repositories and a throwaway PAPERCUTS_HOME. Nothing
 * imports application source, so these tests exercise the shipped contract, not
 * internal wiring.
 *
 * Isolation notes:
 * - Every case uses a fresh PAPERCUTS_HOME so no test can see another's records
 *   and the operator's real store is never touched.
 * - Git is fully de-configured for both the setup commands and the CLI child
 *   (GIT_CONFIG_GLOBAL/SYSTEM point at /dev/null, GIT_CONFIG_NOSYSTEM=1) so the
 *   suite is immune to host git config such as commit signing.
 * - The only credential material is synthetic, assembled in-test by
 *   concatenation; nothing here is or resembles a committed real secret.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "..", "..", "src", "index.ts");

// A synthetic GitHub-style token, built by concatenation so no real-looking
// secret is ever committed. It is placed only in a remote URL's userinfo.
const TOKEN = "ghp" + "_" + "Z".repeat(36);
const CRED_URL = `https://user:${TOKEN}@example.test/owner/repo.git`;
// The path basename the credential-bearing remote must reduce to after the
// userinfo/host are stripped. Both clones derive this display name.
const REMOTE_DISPLAY_NAME = "repo";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; a leaked temp dir must never fail a run.
    }
  }
});

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function gitEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function git(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv() });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
}

interface InitOptions {
  remote?: string;
  branch?: string;
}

/** Create a committed repository at `dir`; return `dir`. */
function initRepo(dir: string, options: InitOptions = {}): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", options.branch ?? "main"]);
  git(dir, ["config", "user.email", "tester@papercuts.test"]);
  git(dir, ["config", "user.name", "Papercuts Tester"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
  if (options.remote !== undefined) {
    git(dir, ["remote", "add", "origin", options.remote]);
  }
  return dir;
}

interface CliOptions {
  cwd: string;
  papercutsHome: string;
  home: string;
  stdin?: string;
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function childEnv(papercutsHome: string, home: string): Record<string, string> {
  const base = { ...(process.env as Record<string, string>) };
  delete base["CODEX_HOME"];
  return {
    ...base,
    HOME: home,
    PAPERCUTS_HOME: papercutsHome,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

async function runCli(
  args: readonly string[],
  options: CliOptions,
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    cwd: options.cwd,
    env: childEnv(options.papercutsHome, options.home),
    stdin:
      options.stdin === undefined
        ? "ignore"
        : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** Parse exactly one JSON success/failure envelope from stdout. */
function parseEnvelope(result: CliResult): Record<string, unknown> {
  const parsed = JSON.parse(result.stdout.trim());
  expect(typeof parsed).toBe("object");
  return parsed as Record<string, unknown>;
}

interface Env {
  papercutsHome: string;
  home: string;
}

/** A fresh, isolated store + throwaway HOME for one test. */
function freshEnv(): Env {
  return { papercutsHome: tempRoot("pc-home-"), home: tempRoot("pc-user-") };
}

function bodiesOf(listEnvelope: Record<string, unknown>): string[] {
  const data = listEnvelope["data"] as { records: Array<{ body: string }> };
  return data.records.map((record) => record.body);
}

/** Concatenate the store's on-disk bytes (main db + WAL + SHM sidecars). */
function readStoreBytes(papercutsHome: string): Buffer {
  const dbPath = join(papercutsHome, "papercuts.sqlite3");
  const chunks: Buffer[] = [];
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(candidate)) {
      chunks.push(readFileSync(candidate));
    }
  }
  return Buffer.concat(chunks);
}

describe("repository-scoped CLI reads", () => {
  test("two clones sharing a credential-bearing remote share one repository identity", async () => {
    const env = freshEnv();
    const base = tempRoot("pc-clones-");
    const cloneA = initRepo(join(base, "cloneA"), { remote: CRED_URL });
    const cloneB = initRepo(join(base, "cloneB"), { remote: CRED_URL });
    // A remote-less repository: its identity is a distinct local key, so its
    // record must NOT bleed into the clones' current scope.
    const outsider = initRepo(join(base, "outsider"));

    for (const [cwd, text] of [
      [cloneA, "cut-A"],
      [cloneB, "cut-B"],
      [outsider, "cut-outsider"],
    ] as const) {
      const added = await runCli(["add", text, "--json"], { ...env, cwd });
      expect(added.exitCode).toBe(0);
    }

    const listA = await runCli(["list", "--repo", "current", "--json"], {
      ...env,
      cwd: cloneA,
    });
    expect(listA.exitCode).toBe(0);
    const envelopeA = parseEnvelope(listA);
    expect(envelopeA["ok"]).toBe(true);

    const bodies = bodiesOf(envelopeA);
    // Shared identity: cloneA's current scope contains cloneB's record.
    expect(bodies).toContain("cut-A");
    expect(bodies).toContain("cut-B");
    // The filter genuinely discriminates: an unrelated repo is excluded.
    expect(bodies).not.toContain("cut-outsider");

    const scope = envelopeA["data"] as {
      scope: { kind: string; repository: { name: string } };
      records: Array<{ repository: { name: string } | null }>;
    };
    expect(scope.scope.kind).toBe("current");
    // The credential-bearing URL is reduced to its safe path basename.
    expect(scope.scope.repository.name).toBe(REMOTE_DISPLAY_NAME);
    for (const record of scope.records) {
      expect(record.repository?.name).toBe(REMOTE_DISPLAY_NAME);
    }

    // Symmetry: cloneB's current scope sees both records too.
    const listB = await runCli(["list", "--repo", "current", "--json"], {
      ...env,
      cwd: cloneB,
    });
    expect(bodiesOf(parseEnvelope(listB)).sort()).toEqual(["cut-A", "cut-B"]);
  });

  test("a linked worktree shares its parent repository identity", async () => {
    const env = freshEnv();
    const base = tempRoot("pc-worktree-");
    const main = initRepo(join(base, "main"));
    const linked = join(base, "linked");
    git(main, ["worktree", "add", "-q", linked, "-b", "feature"]);
    // A separate repository to prove the current-scope filter is not a no-op.
    const other = initRepo(join(base, "other"));

    for (const [cwd, text] of [
      [main, "cut-main"],
      [linked, "cut-linked"],
      [other, "cut-other"],
    ] as const) {
      const added = await runCli(["add", text, "--json"], { ...env, cwd });
      expect(added.exitCode).toBe(0);
    }

    // The main worktree's current scope includes the linked worktree's record
    // because they resolve to the same common Git directory (same identity).
    const fromMain = bodiesOf(
      parseEnvelope(
        await runCli(["list", "--repo", "current", "--json"], {
          ...env,
          cwd: main,
        }),
      ),
    );
    expect(fromMain).toContain("cut-main");
    expect(fromMain).toContain("cut-linked");
    expect(fromMain).not.toContain("cut-other");

    // Identity is symmetric: querying from the linked worktree sees both.
    const fromLinked = bodiesOf(
      parseEnvelope(
        await runCli(["list", "--repo", "current", "--json"], {
          ...env,
          cwd: linked,
        }),
      ),
    );
    expect(fromLinked.sort()).toEqual(["cut-linked", "cut-main"]);
  });

  test("list --repo current isolates one repository while --repo all spans them", async () => {
    const env = freshEnv();
    const base = tempRoot("pc-scope-");
    const repoOne = initRepo(join(base, "repo-one"));
    const repoTwo = initRepo(join(base, "repo-two"));

    await runCli(["add", "one-note", "--json"], { ...env, cwd: repoOne });
    await runCli(["add", "two-note", "--json"], { ...env, cwd: repoTwo });

    const current = bodiesOf(
      parseEnvelope(
        await runCli(["list", "--repo", "current", "--json"], {
          ...env,
          cwd: repoOne,
        }),
      ),
    );
    expect(current).toEqual(["one-note"]);

    const all = bodiesOf(
      parseEnvelope(
        await runCli(["list", "--repo", "all", "--json"], {
          ...env,
          cwd: repoOne,
        }),
      ),
    );
    expect(all.sort()).toEqual(["one-note", "two-note"]);
  });

  test("a subdirectory cwd records a repository-relative working directory", async () => {
    const env = freshEnv();
    const base = tempRoot("pc-subdir-");
    const repo = initRepo(join(base, "repo"));
    const nested = join(repo, "src", "nested");
    mkdirSync(nested, { recursive: true });

    await runCli(["add", "root-note", "--json"], { ...env, cwd: repo });
    await runCli(["add", "nested-note", "--json"], { ...env, cwd: nested });

    const envelope = parseEnvelope(
      await runCli(["list", "--repo", "current", "--json"], {
        ...env,
        cwd: nested,
      }),
    );
    const records = (
      envelope["data"] as {
        records: Array<{
          body: string;
          repository: { name: string; cwdRelative: string } | null;
        }>;
      }
    ).records;

    // The subdirectory and the root belong to the same repository identity.
    expect(records.map((record) => record.body).sort()).toEqual([
      "nested-note",
      "root-note",
    ]);

    const byBody = new Map(records.map((record) => [record.body, record]));
    expect(byBody.get("root-note")?.repository?.cwdRelative).toBe(".");
    expect(byBody.get("nested-note")?.repository?.cwdRelative).toBe("src/nested");
    expect(byBody.get("nested-note")?.repository?.name).toBe(basename(repo));
  });

  test("stats groups records by source, repository, and category", async () => {
    const env = freshEnv();
    const base = tempRoot("pc-stats-");
    const cloneA = initRepo(join(base, "cloneA"), { remote: CRED_URL });
    const cloneB = initRepo(join(base, "cloneB"), { remote: CRED_URL });
    const solo = initRepo(join(base, "solo"));

    await runCli(
      ["add", "a", "--source", "codex", "--category", "cache", "--json"],
      { ...env, cwd: cloneA },
    );
    await runCli(
      ["add", "b", "--source", "claude-code", "--category", "cache", "--json"],
      { ...env, cwd: cloneB },
    );
    await runCli(
      ["add", "c", "--source", "manual", "--category", "docs", "--json"],
      { ...env, cwd: solo },
    );

    const data = parseEnvelope(
      await runCli(["stats", "--repo", "all", "--json"], { ...env, cwd: solo }),
    )["data"] as {
      total: number;
      bySource: Record<string, number>;
      byRepository: Record<string, number>;
      byCategory: Record<string, number>;
      byDay: Record<string, number>;
    };

    expect(data.total).toBe(3);
    expect(data.bySource).toEqual({
      "claude-code": 1,
      codex: 1,
      manual: 1,
    });
    // Both clones collapse onto the single shared remote display name.
    expect(data.byRepository).toEqual({
      [REMOTE_DISPLAY_NAME]: 2,
      solo: 1,
    });
    expect(data.byCategory).toEqual({ cache: 2, docs: 1 });

    // Day bucketing is UTC and total-preserving without pinning to a date the
    // test cannot control across a midnight boundary.
    const dayKeys = Object.keys(data.byDay);
    expect(dayKeys.length).toBeGreaterThanOrEqual(1);
    for (const key of dayKeys) {
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(
      Object.values(data.byDay).reduce((sum, count) => sum + count, 0),
    ).toBe(3);

    // The human view names the same groupings.
    const human = (
      await runCli(["stats", "--repo", "all"], { ...env, cwd: solo })
    ).stdout;
    expect(human).toContain("By source");
    expect(human).toContain("By repository");
    expect(human).toContain("By category");
  });

  test("the remote credential never reaches any output, export, or the database", async () => {
    const env = freshEnv();
    const base = tempRoot("pc-secret-");
    const clone = initRepo(join(base, "clone"), { remote: CRED_URL });
    const body = "a flaky command needed two retries";

    const outputs: string[] = [];

    outputs.push(
      collect(await runCli(["add", body], { ...env, cwd: clone })),
    );
    outputs.push(
      collect(
        await runCli(["list", "--repo", "current"], { ...env, cwd: clone }),
      ),
    );
    outputs.push(
      collect(
        await runCli(["list", "--repo", "current", "--json"], {
          ...env,
          cwd: clone,
        }),
      ),
    );
    outputs.push(
      collect(await runCli(["stats", "--repo", "all"], { ...env, cwd: clone })),
    );
    outputs.push(
      collect(
        await runCli(["stats", "--repo", "all", "--json"], {
          ...env,
          cwd: clone,
        }),
      ),
    );

    const exportStdout = await runCli(["export", "--repo", "current"], {
      ...env,
      cwd: clone,
    });
    outputs.push(collect(exportStdout));

    const exportPath = join(base, "papercuts-export.md");
    await runCli(["export", "--repo", "current", "--output", exportPath], {
      ...env,
      cwd: clone,
    });
    const exportFile = readFileSync(exportPath, "utf8");
    outputs.push(exportFile);

    outputs.push(collect(await runCli(["doctor"], { ...env, cwd: clone })));
    outputs.push(
      collect(await runCli(["doctor", "--json"], { ...env, cwd: clone })),
    );

    const combined = outputs.join("\n");

    // Non-vacuity: attribution actually happened (the safe basename is shown),
    // so an "absent token" result cannot be a silently unscoped record.
    expect(exportFile).toContain("Repository: `repo`");

    // The credential — and the full credential-bearing URL — appear nowhere.
    expect(combined).not.toContain(TOKEN);
    expect(combined).not.toContain(CRED_URL);
    expect(combined).not.toContain(`user:${TOKEN}`);

    // The persisted database (including WAL/SHM) holds the record but not the
    // secret. Proving the body is present makes the token check meaningful.
    const storeBytes = readStoreBytes(env.papercutsHome);
    expect(storeBytes.includes(Buffer.from(body, "utf8"))).toBe(true);
    expect(storeBytes.includes(Buffer.from(TOKEN, "utf8"))).toBe(false);
    expect(storeBytes.includes(Buffer.from(CRED_URL, "utf8"))).toBe(false);
  });

  test("export omits absolute roots and repository fingerprints and is deterministic", async () => {
    const env = freshEnv();
    const base = tempRoot("pc-export-");
    const repo = initRepo(join(base, "repo"));

    await runCli(["add", "first-note", "--json"], { ...env, cwd: repo });
    await runCli(["add", "second-note", "--json"], { ...env, cwd: repo });

    const first = await runCli(["export", "--repo", "all"], {
      ...env,
      cwd: repo,
    });
    const second = await runCli(["export", "--repo", "all"], {
      ...env,
      cwd: repo,
    });
    expect(first.exitCode).toBe(0);
    // Deterministic: byte-identical Markdown for identical input.
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).toContain("# Papercuts");

    // The absolute worktree root must not leak into the export.
    expect(first.stdout).not.toContain(repo);
    // No 64-hex repository fingerprint (the local/remote key) may appear.
    expect(first.stdout).not.toMatch(/[0-9a-f]{64}/);

    // File export refuses to clobber without --force, then succeeds with it.
    const outPath = join(base, "out.md");
    const wrote = await runCli(["export", "--repo", "all", "--output", outPath], {
      ...env,
      cwd: repo,
    });
    expect(wrote.exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);

    const refused = await runCli(
      ["export", "--repo", "all", "--output", outPath],
      { ...env, cwd: repo },
    );
    expect(refused.exitCode).toBe(2);

    const forced = await runCli(
      ["export", "--repo", "all", "--output", outPath, "--force"],
      { ...env, cwd: repo },
    );
    expect(forced.exitCode).toBe(0);
  });

  test("adding from a non-Git directory records an unscoped papercut and exits zero", async () => {
    const env = freshEnv();
    const plain = tempRoot("pc-nongit-");

    const humanAdd = await runCli(["add", "outside any repository"], {
      ...env,
      cwd: plain,
    });
    expect(humanAdd.exitCode).toBe(0);
    expect(humanAdd.stdout).toContain("Recorded papercut");
    // An unscoped record shows no repository line in human output.
    expect(humanAdd.stdout).not.toContain("Repository:");

    const jsonAdd = parseEnvelope(
      await runCli(["add", "second unscoped note", "--json"], {
        ...env,
        cwd: plain,
      }),
    );
    expect(jsonAdd["ok"]).toBe(true);
    expect((jsonAdd["data"] as { repository: unknown }).repository).toBeNull();

    // Outside Git, the records surface under --repo all as unscoped rows.
    const all = parseEnvelope(
      await runCli(["list", "--repo", "all", "--json"], { ...env, cwd: plain }),
    );
    const records = (all["data"] as {
      records: Array<{ body: string; repository: unknown }>;
    }).records;
    expect(records.map((record) => record.body).sort()).toEqual([
      "outside any repository",
      "second unscoped note",
    ]);
    for (const record of records) {
      expect(record.repository).toBeNull();
    }

    // Requesting the current repository outside Git is a validation error.
    const current = await runCli(["list", "--repo", "current", "--json"], {
      ...env,
      cwd: plain,
    });
    expect(current.exitCode).toBe(2);
    const failure = parseEnvelope(current);
    expect(failure["ok"]).toBe(false);
    expect(current.stderr).toBe("");
  });
});

/** Merge a result's stdout and stderr for substring scanning. */
function collect(result: CliResult): string {
  return `${result.stdout}\n${result.stderr}`;
}
