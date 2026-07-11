import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * Black-box acceptance tests for `papercuts setup`.
 *
 * Every assertion drives the real CLI as a subprocess (`bun src/index.ts …`)
 * with an explicit `cwd` and a fully isolated `HOME`, `CODEX_HOME`, and
 * `PAPERCUTS_HOME` pointed at a fresh temp tree. The suite never imports setup
 * internals and never touches the operator's real `~` or application data
 * directory. `HOME` is overridden on every spawn because `os.homedir()` reads
 * it, so Claude Code user scope resolves inside the fixture.
 */

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const BEGIN_MARKER = "<!-- papercuts:begin v1 -->";
const END_MARKER = "<!-- papercuts:end -->";
// Constructed in-test; never a real credential and never committed as one.
const CANARY = "CANARY_" + "DO_NOT_ECHO_" + "9137";

interface Fixture {
  base: string;
  home: string;
  codexHome: string;
  repo: string;
  papercutsHome: string;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A per-entry descriptor map of a directory tree, excluding `.git`. */
type TreeSnapshot = Record<string, string>;

async function makeFixture(): Promise<Fixture> {
  // Canonicalize so paths match the realpath the CLI computes for scope roots;
  // this keeps deliberately-introduced symlinks the only symlink in any path.
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "papercuts-setup-safety-")),
  );
  const home = join(base, "home");
  const codexHome = join(home, ".codex");
  const repo = join(base, "repo");
  // Intentionally never created: setup must not materialize the data directory.
  const papercutsHome = join(base, "papercuts-data-home");

  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(repo, { recursive: true, mode: 0o700 });

  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  if (init.exitCode !== 0) {
    throw new Error("git init failed for fixture repository");
  }

  return { base, home, codexHome, repo, papercutsHome };
}

function isolatedEnv(fixture: Fixture): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Redirect every home-derived location into the fixture so no real config,
  // Codex home, or application data directory can ever be read or written.
  env["HOME"] = fixture.home;
  env["CODEX_HOME"] = fixture.codexHome;
  env["PAPERCUTS_HOME"] = fixture.papercutsHome;
  return env;
}

async function runCli(
  fixture: Fixture,
  args: readonly string[],
  cwd: string,
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    cwd,
    env: isolatedEnv(fixture),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/**
 * Snapshot every entry under `dir` (recursively, excluding `.git`) as a stable
 * descriptor: files as `F <octal-mode> <sha256>`, directories as `D
 * <octal-mode>`, symlinks as `L <target>`. Comparing two snapshots detects any
 * byte, permission, or structural change.
 */
async function snapshotTree(dir: string): Promise<TreeSnapshot> {
  const out: TreeSnapshot = {};

  async function walk(current: string, relative: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }

      const absolute = join(current, entry.name);
      const key = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const status = await lstat(absolute);
      const mode = (status.mode & 0o777).toString(8);

      if (status.isSymbolicLink()) {
        out[key] = `L ${await readlink(absolute)}`;
      } else if (status.isDirectory()) {
        out[key] = `D ${mode}`;
        await walk(absolute, key);
      } else if (status.isFile()) {
        const bytes = await readFile(absolute);
        out[key] = `F ${mode} ${createHash("sha256").update(bytes).digest("hex")}`;
      } else {
        out[key] = "O";
      }
    }
  }

  await walk(dir, "");
  return out;
}

/** Assert every entry present in `before` is byte/mode/structure identical in
 * `after`, ignoring the managed target itself. New entries in `after` (created
 * managed files, empty owned dirs) are tolerated, so this expresses
 * "surrounding content is untouched". */
function expectSurroundingUnchanged(
  before: TreeSnapshot,
  after: TreeSnapshot,
  ignoreKeys: readonly string[] = [],
): void {
  const ignored = new Set(ignoreKeys);
  let compared = 0;
  for (const [key, descriptor] of Object.entries(before)) {
    if (ignored.has(key)) {
      continue;
    }
    expect(after[key]).toBe(descriptor);
    compared += 1;
  }
  // Guard against a vacuous pass: there must be surrounding content to check.
  expect(compared).toBeGreaterThan(0);
}

/** The snapshot key (a `/`-joined relative path) for an absolute path under a
 * snapshot root, matching how {@link snapshotTree} names its entries. */
function snapshotKey(root: string, absolute: string): string {
  return relative(root, absolute).split(/[\\/]/).join("/");
}

function expectNoDataDirectory(fixture: Fixture): void {
  expect(existsSync(fixture.papercutsHome)).toBe(false);
}

function parseJson(result: CliResult): Record<string, unknown> {
  // JSON mode must emit exactly one object and a trailing newline, no prose.
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  expect(result.stdout).not.toContain("");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function expectSetupConflict(result: CliResult): void {
  expect(result.code).toBe(4);
  const envelope = parseJson(result);
  expect(envelope["ok"]).toBe(false);
  expect(envelope["command"]).toBe("setup");
  expect(envelope["error"]).toEqual({
    code: "setup_conflict",
    message: "Managed setup content has changed.",
    retryable: false,
  });
  // A conflict is a sanitized boundary: no drifted content may leak to output.
  expect(result.stdout).not.toContain(CANARY);
  expect(result.stderr).not.toContain(CANARY);
}

async function cleanup(fixture: Fixture): Promise<void> {
  await rm(fixture.base, { recursive: true, force: true });
}

describe("papercuts setup preview safety (black-box CLI)", () => {
  test("codex user scope preview leaves the tree byte-identical and creates no data directory", async () => {
    const fixture = await makeFixture();

    try {
      await writeFile(
        join(fixture.codexHome, "AGENTS.md"),
        "# global codex guidance\nkeep this line\n",
        { mode: 0o644 },
      );
      await mkdir(join(fixture.codexHome, "config"), { mode: 0o700 });
      await writeFile(
        join(fixture.codexHome, "config", "settings.toml"),
        "unrelated = true\n",
      );

      const before = await snapshotTree(fixture.home);
      const result = await runCli(
        fixture,
        ["setup", "codex", "--scope", "user", "--json"],
        fixture.home,
      );

      expect(result.code).toBe(0);
      expect(parseJson(result)["ok"]).toBe(true);
      expect(await snapshotTree(fixture.home)).toEqual(before);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  test("codex repo scope preview never creates the absent AGENTS.md target", async () => {
    const fixture = await makeFixture();

    try {
      await writeFile(join(fixture.repo, "README.md"), "readme body\n");
      const before = await snapshotTree(fixture.repo);

      const result = await runCli(
        fixture,
        ["setup", "codex", "--scope", "repo", "--json"],
        fixture.repo,
      );

      expect(result.code).toBe(0);
      const envelope = parseJson(result);
      expect(envelope["ok"]).toBe(true);
      // The plan proposes writing AGENTS.md, but preview must not create it.
      expect(existsSync(join(fixture.repo, "AGENTS.md"))).toBe(false);
      expect(await snapshotTree(fixture.repo)).toEqual(before);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  test("claude-code user scope preview never creates the adapter-owned file", async () => {
    const fixture = await makeFixture();

    try {
      await writeFile(join(fixture.home, "notes.txt"), "preexisting user note\n");
      const before = await snapshotTree(fixture.home);

      const result = await runCli(
        fixture,
        ["setup", "claude-code", "--scope", "user", "--json"],
        fixture.home,
      );

      expect(result.code).toBe(0);
      expect(parseJson(result)["ok"]).toBe(true);
      expect(
        existsSync(join(fixture.home, ".claude", "rules", "papercuts.md")),
      ).toBe(false);
      expect(await snapshotTree(fixture.home)).toEqual(before);
      // The operator's real ~/.claude must never be consulted or written.
      expect(existsSync(join(fixture.home, ".claude"))).toBe(false);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  test("claude-code repo scope preview leaves the working tree byte-identical", async () => {
    const fixture = await makeFixture();

    try {
      await mkdir(join(fixture.repo, "src"), { mode: 0o755 });
      await writeFile(join(fixture.repo, "src", "main.ts"), "export const x = 1;\n");
      const before = await snapshotTree(fixture.repo);

      const result = await runCli(
        fixture,
        ["setup", "claude-code", "--scope", "repo", "--json"],
        fixture.repo,
      );

      expect(result.code).toBe(0);
      expect(parseJson(result)["ok"]).toBe(true);
      expect(await snapshotTree(fixture.repo)).toEqual(before);
      expect(existsSync(join(fixture.repo, ".claude"))).toBe(false);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  test("generic preview prints the portable snippet and writes nothing", async () => {
    const fixture = await makeFixture();

    try {
      const before = await snapshotTree(fixture.home);

      const result = await runCli(
        fixture,
        ["setup", "generic", "--json"],
        fixture.home,
      );

      expect(result.code).toBe(0);
      const envelope = parseJson(result);
      expect(envelope["ok"]).toBe(true);
      expect(envelope["data"]).toMatchObject({ harness: "generic" });
      const snippet = (envelope["data"] as Record<string, unknown>)["snippet"];
      expect(typeof snippet).toBe("string");
      expect(snippet as string).toContain(BEGIN_MARKER);
      expect(await snapshotTree(fixture.home)).toEqual(before);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });
});

describe("papercuts setup apply/reapply/undo byte-safety (black-box CLI)", () => {
  test("codex user scope apply appends, reapply is a no-op, and undo restores surrounding bytes", async () => {
    const fixture = await makeFixture();

    try {
      const target = join(fixture.codexHome, "AGENTS.md");
      const original = "# global codex guidance\nkeep this exact line\n";
      await writeFile(target, original, { mode: 0o644 });
      await chmod(target, 0o644);
      await mkdir(join(fixture.codexHome, "prompts"), { mode: 0o700 });
      await writeFile(
        join(fixture.codexHome, "prompts", "unrelated.md"),
        "leave me alone\n",
      );
      const originalBytes = await readFile(target);
      const surrounding = await snapshotTree(fixture.home);
      const targetKey = snapshotKey(fixture.home, target);

      const applied = await runCli(
        fixture,
        ["setup", "codex", "--scope", "user", "--apply", "--json"],
        fixture.home,
      );
      expect(applied.code).toBe(0);
      const appliedContent = await readFile(target, "utf8");
      expect(appliedContent).toStartWith(original);
      expect(appliedContent).toContain(BEGIN_MARKER);
      expect(appliedContent).toContain(END_MARKER);
      // Existing mode is preserved, not forced to 0600.
      expect((await lstat(target)).mode & 0o777).toBe(0o644);
      expectSurroundingUnchanged(surrounding, await snapshotTree(fixture.home), [
        targetKey,
      ]);

      const reapplied = await runCli(
        fixture,
        ["setup", "codex", "--scope", "user", "--apply", "--json"],
        fixture.home,
      );
      expect(reapplied.code).toBe(0);
      expect(parseJson(reapplied)["data"]).toMatchObject({
        state: "current",
        mutations: [],
      });
      expect(await readFile(target, "utf8")).toBe(appliedContent);

      const undone = await runCli(
        fixture,
        ["setup", "codex", "--scope", "user", "--undo", "--apply", "--json"],
        fixture.home,
      );
      expect(undone.code).toBe(0);
      // Undo restores the file to its exact pre-install bytes and mode.
      expect(await readFile(target)).toEqual(originalBytes);
      expect((await lstat(target)).mode & 0o777).toBe(0o644);
      expectSurroundingUnchanged(surrounding, await snapshotTree(fixture.home), [
        targetKey,
      ]);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  test("codex repo scope apply/reapply/undo preserves surrounding files and CRLF-free bytes", async () => {
    const fixture = await makeFixture();

    try {
      const target = join(fixture.repo, "AGENTS.md");
      const original = "# repo agents\nproject guidance\n";
      await writeFile(target, original, { mode: 0o640 });
      await chmod(target, 0o640);
      await writeFile(join(fixture.repo, "README.md"), "readme stays put\n");
      const originalBytes = await readFile(target);
      const surrounding = await snapshotTree(fixture.repo);
      const targetKey = snapshotKey(fixture.repo, target);

      const applied = await runCli(
        fixture,
        ["setup", "codex", "--scope", "repo", "--apply", "--json"],
        fixture.repo,
      );
      expect(applied.code).toBe(0);
      const appliedContent = await readFile(target, "utf8");
      expect(appliedContent).toStartWith(original);
      expect(appliedContent).toContain(BEGIN_MARKER);
      expect((await lstat(target)).mode & 0o777).toBe(0o640);
      expectSurroundingUnchanged(surrounding, await snapshotTree(fixture.repo), [
        targetKey,
      ]);

      const reapplied = await runCli(
        fixture,
        ["setup", "codex", "--scope", "repo", "--apply", "--json"],
        fixture.repo,
      );
      expect(reapplied.code).toBe(0);
      expect(parseJson(reapplied)["data"]).toMatchObject({ state: "current" });
      expect(await readFile(target, "utf8")).toBe(appliedContent);

      const undone = await runCli(
        fixture,
        ["setup", "codex", "--scope", "repo", "--undo", "--apply", "--json"],
        fixture.repo,
      );
      expect(undone.code).toBe(0);
      expect(await readFile(target)).toEqual(originalBytes);
      expect((await lstat(target)).mode & 0o777).toBe(0o640);
      expectSurroundingUnchanged(surrounding, await snapshotTree(fixture.repo), [
        targetKey,
      ]);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  test("claude-code user scope apply/reapply/undo leaves every pre-existing file byte-identical", async () => {
    const fixture = await makeFixture();

    try {
      await writeFile(join(fixture.home, "notes.txt"), "user note stays\n");
      await mkdir(join(fixture.home, ".config"), { mode: 0o700 });
      await writeFile(join(fixture.home, ".config", "keep.conf"), "keep=1\n");
      const surrounding = await snapshotTree(fixture.home);
      const target = join(fixture.home, ".claude", "rules", "papercuts.md");

      const applied = await runCli(
        fixture,
        ["setup", "claude-code", "--scope", "user", "--apply", "--json"],
        fixture.home,
      );
      expect(applied.code).toBe(0);
      // Adapter-owned file holds only the generated block, at mode 0600.
      const ownedContent = await readFile(target, "utf8");
      expect(ownedContent).toStartWith(BEGIN_MARKER);
      expect(ownedContent).toEndWith(END_MARKER);
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
      expectSurroundingUnchanged(surrounding, await snapshotTree(fixture.home));

      const reapplied = await runCli(
        fixture,
        ["setup", "claude-code", "--scope", "user", "--apply", "--json"],
        fixture.home,
      );
      expect(reapplied.code).toBe(0);
      expect(parseJson(reapplied)["data"]).toMatchObject({ state: "current" });
      expect(await readFile(target, "utf8")).toBe(ownedContent);

      const undone = await runCli(
        fixture,
        ["setup", "claude-code", "--scope", "user", "--undo", "--apply", "--json"],
        fixture.home,
      );
      expect(undone.code).toBe(0);
      // The adapter-owned file is deleted; surrounding files remain untouched.
      expect(existsSync(target)).toBe(false);
      expectSurroundingUnchanged(surrounding, await snapshotTree(fixture.home));
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  test("claude-code repo scope apply/reapply/undo preserves the surrounding working tree", async () => {
    const fixture = await makeFixture();

    try {
      await writeFile(join(fixture.repo, "package.json"), "{}\n");
      await mkdir(join(fixture.repo, "docs"), { mode: 0o755 });
      await writeFile(join(fixture.repo, "docs", "guide.md"), "# guide\n");
      const surrounding = await snapshotTree(fixture.repo);
      const target = join(fixture.repo, ".claude", "rules", "papercuts.md");

      const applied = await runCli(
        fixture,
        ["setup", "claude-code", "--scope", "repo", "--apply", "--json"],
        fixture.repo,
      );
      expect(applied.code).toBe(0);
      const ownedContent = await readFile(target, "utf8");
      expect(ownedContent).toStartWith(BEGIN_MARKER);
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
      expectSurroundingUnchanged(surrounding, await snapshotTree(fixture.repo));

      const reapplied = await runCli(
        fixture,
        ["setup", "claude-code", "--scope", "repo", "--apply", "--json"],
        fixture.repo,
      );
      expect(reapplied.code).toBe(0);
      expect(await readFile(target, "utf8")).toBe(ownedContent);

      const undone = await runCli(
        fixture,
        ["setup", "claude-code", "--scope", "repo", "--undo", "--apply", "--json"],
        fixture.repo,
      );
      expect(undone.code).toBe(0);
      expect(existsSync(target)).toBe(false);
      expectSurroundingUnchanged(surrounding, await snapshotTree(fixture.repo));
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });
});

describe("papercuts setup conflicts fail without mutation (black-box CLI)", () => {
  test("preimage drift (tampered managed block) is refused and the target is unchanged", async () => {
    const fixture = await makeFixture();

    try {
      const target = join(fixture.repo, "AGENTS.md");
      const drifted = `# repo\n${BEGIN_MARKER}\n${CANARY} hand-edited managed body\n${END_MARKER}\n`;
      await writeFile(target, drifted);
      const before = await snapshotTree(fixture.repo);

      const result = await runCli(
        fixture,
        ["setup", "codex", "--scope", "repo", "--apply", "--json"],
        fixture.repo,
      );

      expectSetupConflict(result);
      expect(await readFile(target, "utf8")).toBe(drifted);
      expect(await snapshotTree(fixture.repo)).toEqual(before);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  test("malformed markers (duplicate begin) are refused without mutation", async () => {
    const fixture = await makeFixture();

    try {
      const target = join(fixture.repo, "AGENTS.md");
      const malformed = `${BEGIN_MARKER}\n${CANARY}\n${BEGIN_MARKER}\n${END_MARKER}\n`;
      await writeFile(target, malformed);
      const before = await snapshotTree(fixture.repo);

      const result = await runCli(
        fixture,
        ["setup", "codex", "--scope", "repo", "--apply", "--json"],
        fixture.repo,
      );

      expectSetupConflict(result);
      expect(await readFile(target, "utf8")).toBe(malformed);
      expect(await snapshotTree(fixture.repo)).toEqual(before);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  test("a symlinked target file is refused, leaving link and pointee intact", async () => {
    const fixture = await makeFixture();

    try {
      const outside = join(fixture.base, "outside-target.md");
      await writeFile(outside, `${CANARY} outside content stays\n`);
      const target = join(fixture.repo, "AGENTS.md");
      await symlink(outside, target);
      const before = await snapshotTree(fixture.repo);

      const result = await runCli(
        fixture,
        ["setup", "codex", "--scope", "repo", "--apply", "--json"],
        fixture.repo,
      );

      expectSetupConflict(result);
      // The symlink is preserved and its target file is never overwritten.
      expect((await lstat(target)).isSymbolicLink()).toBe(true);
      expect(await readFile(outside, "utf8")).toBe(`${CANARY} outside content stays\n`);
      expect(await snapshotTree(fixture.repo)).toEqual(before);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  test("a symlinked parent directory is refused without following the link", async () => {
    const fixture = await makeFixture();

    try {
      const outside = join(fixture.base, "outside-parent");
      await mkdir(outside, { mode: 0o700 });
      // .claude is a symlink out of the repo; the adapter target would land in
      // `outside/rules/papercuts.md` if the link were followed.
      await symlink(outside, join(fixture.repo, ".claude"));
      const before = await snapshotTree(fixture.repo);

      const result = await runCli(
        fixture,
        ["setup", "claude-code", "--scope", "repo", "--apply", "--json"],
        fixture.repo,
      );

      expectSetupConflict(result);
      expect((await lstat(join(fixture.repo, ".claude"))).isSymbolicLink()).toBe(
        true,
      );
      expect(existsSync(join(outside, "rules"))).toBe(false);
      expect(await snapshotTree(fixture.repo)).toEqual(before);
      // The symlinked-out directory gained nothing either.
      expect(await readdir(outside)).toEqual([]);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  test("generic harness rejects --apply in JSON mode and writes nothing", async () => {
    const fixture = await makeFixture();

    try {
      const before = await snapshotTree(fixture.home);

      const result = await runCli(
        fixture,
        ["setup", "generic", "--apply", "--json"],
        fixture.home,
      );

      expectSetupConflict(result);
      expect(await snapshotTree(fixture.home)).toEqual(before);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });

  test("generic harness rejects --apply in human mode with a sanitized stderr line and empty stdout", async () => {
    const fixture = await makeFixture();

    try {
      const before = await snapshotTree(fixture.home);

      const result = await runCli(
        fixture,
        ["setup", "generic", "--apply"],
        fixture.home,
      );

      expect(result.code).toBe(4);
      expect(result.stdout).toBe("");
      expect(result.stderr.trimEnd()).toBe("Managed setup content has changed.");
      expect(await snapshotTree(fixture.home)).toEqual(before);
      expectNoDataDirectory(fixture);
    } finally {
      await cleanup(fixture);
    }
  });
});
