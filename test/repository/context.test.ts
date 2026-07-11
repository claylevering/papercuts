import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { ScreenedText } from "../../src/domain/types";
import { PapercutsError } from "../../src/domain/errors";
import { sha256Hex } from "../../src/platform/hash";
import { resolveRepoContext } from "../../src/repository/context";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("resolveRepoContext", () => {
  test("discovers the real root and normalizes root and nested working directories", async () => {
    const { repo } = await createRepository({ commit: true });
    const nested = join(repo, "nested", "child");
    await mkdir(nested, { recursive: true });

    const rootContext = await resolveRepoContext(repo);
    const nestedContext = await resolveRepoContext(nested);

    expect(String(rootContext?.context.root)).toBe(await realpath(repo));
    expect(String(rootContext?.context.cwdRelative)).toBe(".");
    expect(String(rootContext?.context.displayName)).toBe(basename(repo));
    expect(String(nestedContext?.context.root)).toBe(await realpath(repo));
    expect(String(nestedContext?.context.cwdRelative)).toBe("nested/child");
    expect(nestedContext?.context.key).toBe(rootContext?.context.key);
    expect(nestedContext?.context.keyKind).toBe("local");
  });

  test("uses the common directory device and inode for linked-worktree identity", async () => {
    const { base, repo } = await createRepository({ commit: true });
    const linked = join(base, "linked-worktree");
    await git(repo, ["worktree", "add", "-b", "linked", linked]);

    const primaryContext = await resolveRepoContext(repo);
    const linkedContext = await resolveRepoContext(linked);
    const expectedKey = await expectedLocalKey(repo);

    expect(primaryContext?.context.keyKind).toBe("local");
    expect(linkedContext?.context.keyKind).toBe("local");
    expect(primaryContext?.context.key).toBe(expectedKey);
    expect(linkedContext?.context.key).toBe(expectedKey);
    expect(String(linkedContext?.context.root)).toBe(await realpath(linked));
  });

  test("uses one sanitized remote identity across separate clones", async () => {
    const base = await createTemporaryDirectory();
    const seed = join(base, "seed");
    const bare = join(base, "origin.git");
    const firstClone = join(base, "clone-one");
    const secondClone = join(base, "clone-two");
    await initializeRepository(seed, true);
    await git(base, ["clone", "--bare", seed, bare]);
    await git(base, ["clone", bare, firstClone]);
    await git(base, ["clone", bare, secondClone]);

    const rawRemote =
      "https://remote-user:remote-password@Example.COM/Owner/Repo.git?token=discarded#discarded";
    await git(firstClone, ["remote", "set-url", "origin", rawRemote]);
    await git(secondClone, ["remote", "set-url", "origin", rawRemote]);

    const first = await resolveRepoContext(firstClone);
    const second = await resolveRepoContext(secondClone);
    const expectedKey = sha256Hex("remote:example.com/Owner/Repo");

    expect(first?.context.keyKind).toBe("remote");
    expect(first?.context.key).toBe(expectedKey);
    expect(second?.context.key).toBe(expectedKey);
    expect(String(first?.context.displayName)).toBe("Repo");
    expect(JSON.stringify(first)).not.toContain("remote-password");
    expect(JSON.stringify(first)).not.toContain("remote-user");
    expect(JSON.stringify(first)).not.toContain("discarded");
  });

  test("captures a branch and full HEAD, then represents detached HEAD safely", async () => {
    const { repo } = await createRepository({ commit: true });
    const head = await gitStdout(repo, ["rev-parse", "HEAD"]);

    const attached = await resolveRepoContext(repo);

    expect(String(attached?.context.branch)).toBe("main");
    expect(String(attached?.context.head)).toBe(head);
    expect(attached?.context.head).toHaveLength(40);

    await git(repo, ["checkout", "--detach", "HEAD"]);
    const detached = await resolveRepoContext(repo);

    expect(detached?.context.branch).toBeNull();
    expect(String(detached?.context.head)).toBe(head);
  });

  test("captures an unborn branch with no HEAD", async () => {
    const { repo } = await createRepository();

    const context = await resolveRepoContext(repo);

    expect(String(context?.context.branch)).toBe("main");
    expect(context?.context.head).toBeNull();
  });

  test("returns null for an ordinary non-Git directory", async () => {
    const directory = await createTemporaryDirectory();

    await expect(resolveRepoContext(directory)).resolves.toBeNull();
  });

  test("selects origin ahead of other remotes", async () => {
    const { repo } = await createRepository({ commit: true });
    await git(repo, [
      "remote",
      "add",
      "backup",
      "https://example.com/Other/Backup.git",
    ]);
    await git(repo, [
      "remote",
      "add",
      "origin",
      "https://example.com/Chosen/Origin.git",
    ]);

    const context = await resolveRepoContext(repo);

    expect(context?.context.keyKind).toBe("remote");
    expect(context?.context.key).toBe(
      sha256Hex("remote:example.com/Chosen/Origin"),
    );
    expect(String(context?.context.displayName)).toBe("Origin");
  });

  test("selects a sole non-origin remote", async () => {
    const { repo } = await createRepository({ commit: true });
    await git(repo, [
      "remote",
      "add",
      "upstream",
      "git@example.com:Owner/Upstream.git",
    ]);

    const context = await resolveRepoContext(repo);

    expect(context?.context.keyKind).toBe("remote");
    expect(context?.context.key).toBe(
      sha256Hex("remote:example.com/Owner/Upstream"),
    );
    expect(String(context?.context.displayName)).toBe("Upstream");
  });

  test("uses local identity when multiple non-origin remotes are ambiguous", async () => {
    const { repo } = await createRepository({ commit: true });
    await git(repo, [
      "remote",
      "add",
      "first",
      "https://example.com/Owner/First.git",
    ]);
    await git(repo, [
      "remote",
      "add",
      "second",
      "https://example.com/Owner/Second.git",
    ]);

    const context = await resolveRepoContext(repo);

    expect(context?.context.keyKind).toBe("local");
    expect(context?.context.key).toBe(await expectedLocalKey(repo));
    expect(String(context?.context.displayName)).toBe(basename(repo));
  });

  test("screens every returned repository string and accounts for replacements", async () => {
    const rootCredential = "ghp_" + "R".repeat(24);
    const cwdAssignment = "API_TOKEN=" + "C".repeat(32);
    const branchCredential = "ghp_" + "B".repeat(24);
    const remoteAssignment = "API_TOKEN=" + "M".repeat(32);
    const { repo } = await createRepository({
      commit: true,
      name: `project-${rootCredential}`,
    });
    const nested = join(repo, cwdAssignment);
    await mkdir(nested);
    await git(repo, ["checkout", "-b", `feature/${branchCredential}`]);
    await git(repo, [
      "remote",
      "add",
      "origin",
      `https://example.com/Owner/${remoteAssignment}.git`,
    ]);

    const resolved = await resolveRepoContext(nested);
    expect(resolved).not.toBeNull();
    if (resolved === null) {
      throw new Error("expected repository context");
    }

    const screenedFields: readonly (ScreenedText | null)[] = [
      resolved.context.displayName,
      resolved.context.root,
      resolved.context.cwdRelative,
      resolved.context.branch,
      resolved.context.head,
    ];
    const serialized = JSON.stringify(resolved);

    for (const canary of [
      rootCredential,
      cwdAssignment,
      branchCredential,
      remoteAssignment,
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(screenedFields.map(String)).toEqual(
      expect.arrayContaining([
        "[REDACTED:SECRET]",
        "feature/[REDACTED:CREDENTIAL]",
      ]),
    );
    expect(resolved.context.root).toContain("[REDACTED:CREDENTIAL]");
    expect(String(resolved.context.cwdRelative)).toBe("[REDACTED:SECRET]");
    expect(resolved.context.keyKind).toBe("local");
    expect(resolved.context.key).toBe(await expectedLocalKey(repo));
    expect(resolved.redactionCount).toBe(4);
  });

  test("never hashes a screened remote preimage into remote identity", async () => {
    const remoteCredential = "ghp_" + "Q".repeat(24);
    const { repo } = await createRepository({ commit: true });
    await git(repo, [
      "remote",
      "add",
      "origin",
      `https://example.com/Owner/${remoteCredential}.git`,
    ]);

    const context = await resolveRepoContext(repo);
    const expectedKey = await expectedLocalKey(repo);

    expect(context?.context.keyKind).toBe("local");
    expect(context?.context.key).toBe(expectedKey);
    expect(String(context?.context.displayName)).toBe(
      "[REDACTED:CREDENTIAL]",
    );
    expect(JSON.stringify(context)).not.toContain(remoteCredential);
    expect(context?.context.key).not.toBe(
      sha256Hex("remote:example.com/Owner/[REDACTED:CREDENTIAL]"),
    );
  });

  test("screens percent-encoded remote credentials before choosing identity", async () => {
    const remoteCredential = "ghp_" + "P".repeat(24);
    const encodedCredential = remoteCredential.replace("_", "%5F");
    const { repo } = await createRepository({ commit: true });
    await git(repo, [
      "remote",
      "add",
      "origin",
      `https://example.com/Owner/${encodedCredential}.git`,
    ]);

    const context = await resolveRepoContext(repo);

    expect(context?.context.keyKind).toBe("local");
    expect(context?.context.key).toBe(await expectedLocalKey(repo));
    expect(String(context?.context.displayName)).toBe(
      "[REDACTED:CREDENTIAL]",
    );
    expect(JSON.stringify(context)).not.toContain(remoteCredential);
    expect(JSON.stringify(context)).not.toContain(encodedCredential);
  });

  test("sanitizes unexpected discovery failures without returning raw path canaries", async () => {
    const pathCredential = "ghp_" + "Z".repeat(24);
    const missingPath = join(
      await createTemporaryDirectory(),
      pathCredential,
      "missing",
    );

    try {
      await resolveRepoContext(missingPath);
      throw new Error("expected repository discovery to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PapercutsError);
      expect((error as PapercutsError).code).toBe("internal_error");
      expect(String(error)).not.toContain(pathCredential);
      expect(JSON.stringify(error)).not.toContain(pathCredential);
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "papercuts-context-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createRepository(options: {
  name?: string;
  commit?: boolean;
} = {}): Promise<{ base: string; repo: string }> {
  const base = await createTemporaryDirectory();
  const repo = join(base, options.name ?? "repository");
  await initializeRepository(repo, options.commit ?? false);
  return { base, repo };
}

async function initializeRepository(
  repo: string,
  createCommit: boolean,
): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Papercuts Test"]);
  await git(repo, ["config", "user.email", "papercuts@example.test"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);

  if (createCommit) {
    await writeFile(join(repo, "fixture.txt"), "fixture\n", "utf8");
    await git(repo, ["add", "fixture.txt"]);
    await git(repo, ["commit", "-m", "fixture"]);
  }
}

async function expectedLocalKey(repo: string): Promise<string> {
  const commonDirectory = await gitStdout(repo, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const metadata = await stat(await realpath(commonDirectory), { bigint: true });
  return sha256Hex(`local:${metadata.dev}:${metadata.ino}`);
}

async function gitStdout(cwd: string, args: readonly string[]): Promise<string> {
  return (await git(cwd, args)).stdout.trim();
}

async function git(
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error("Git fixture command failed.");
  }

  return { stdout, stderr };
}
