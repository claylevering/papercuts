import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "../../src/platform/hash";
import {
  renderClaudeInstructions,
  renderCodexInstructions,
} from "../../src/setup/content";
import { planSetup } from "../../src/setup/adapters";

interface Fixture {
  base: string;
  home: string;
  repo: string;
  codexHome: string;
}

async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "papercuts-setup-plan-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  const codexHome = join(base, "codex-home");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(repo, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
  ]);
  return { base, home, repo, codexHome };
}

async function snapshotTree(root: string): Promise<readonly string[]> {
  const snapshot: string[] = [];

  async function visit(path: string, relativePath: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const child = join(path, entry.name);
      const childRelative = join(relativePath, entry.name);
      const status = await lstat(child);
      snapshot.push(
        `${childRelative}:${entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other"}:${(status.mode & 0o777).toString(8)}`,
      );

      if (entry.isDirectory()) {
        await visit(child, childRelative);
      } else if (entry.isFile()) {
        snapshot.push(`${childRelative}:bytes:${(await readFile(child)).toString("hex")}`);
      }
    }
  }

  await visit(root, ".");
  return snapshot;
}

describe("setup adapter planning", () => {
  test("Codex user scope selects a non-empty CODEX_HOME override without writes", async () => {
    const fixture = await createFixture();

    try {
      const fallback = "# fallback CANARY_FALLBACK\n";
      const active = "# active CANARY_ACTIVE\n";
      await writeFile(join(fixture.codexHome, "AGENTS.md"), fallback);
      await writeFile(join(fixture.codexHome, "AGENTS.override.md"), active);
      const before = await snapshotTree(fixture.base);
      const scope = { kind: "user" } as const;

      const plan = await planSetup({
        harness: "codex",
        action: "install",
        scope,
        home: fixture.home,
        codexHome: fixture.codexHome,
      });

      expect(plan.scope).toEqual(scope);
      expect(plan.canonicalScopeRoot).toBe(await realpath(fixture.codexHome));
      expect(plan.state).toBe("absent");
      expect(plan.mutations).toHaveLength(1);
      expect(plan.mutations[0]).toMatchObject({
        path: join(await realpath(fixture.codexHome), "AGENTS.override.md"),
        expectedSha256: sha256Hex(active),
        createMode: 0o600,
      });
      expect(plan.mutations[0]?.nextContent).toStartWith(active);
      expect(plan.mutations[0]?.nextContent).toContain(
        "papercuts add --stdin --source codex",
      );
      expect(plan.mutations[0]?.managedDiff.join("\n")).not.toContain(
        "CANARY_ACTIVE",
      );
      expect(plan.mutations[0]?.managedDiff.join("\n")).not.toContain(
        "CANARY_FALLBACK",
      );
      expect(await snapshotTree(fixture.base)).toEqual(before);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("Codex user scope falls back to AGENTS.md for a whitespace-only override", async () => {
    const fixture = await createFixture();

    try {
      await writeFile(join(fixture.codexHome, "AGENTS.override.md"), " \r\n\t");
      await writeFile(join(fixture.codexHome, "AGENTS.md"), "# active\n");

      const plan = await planSetup({
        harness: "codex",
        action: "install",
        scope: { kind: "user" },
        home: fixture.home,
        codexHome: fixture.codexHome,
      });

      expect(plan.mutations[0]?.path).toBe(
        join(await realpath(fixture.codexHome), "AGENTS.md"),
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("Codex repo scope uses a non-empty root override, then root AGENTS.md", async () => {
    const fixture = await createFixture();

    try {
      const overridePath = join(fixture.repo, "AGENTS.override.md");
      await writeFile(overridePath, "# repository override\n");
      const request = {
        harness: "codex" as const,
        action: "install" as const,
        scope: { kind: "repo" as const, root: fixture.repo },
        home: fixture.home,
      };

      const overridePlan = await planSetup(request);
      expect(overridePlan.scope).toEqual(request.scope);
      expect(overridePlan.canonicalScopeRoot).toBe(await realpath(fixture.repo));
      expect(overridePlan.mutations[0]?.path).toBe(
        join(await realpath(fixture.repo), "AGENTS.override.md"),
      );

      await writeFile(overridePath, "\n");
      const fallbackPlan = await planSetup(request);
      expect(fallbackPlan.mutations[0]?.path).toBe(
        join(await realpath(fixture.repo), "AGENTS.md"),
      );
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("Claude Code owns only its user and repository rules targets", async () => {
    const fixture = await createFixture();

    try {
      const before = await snapshotTree(fixture.base);
      const userPlan = await planSetup({
        harness: "claude-code",
        action: "install",
        scope: { kind: "user" },
        home: fixture.home,
      });
      const repoPlan = await planSetup({
        harness: "claude-code",
        action: "install",
        scope: { kind: "repo", root: fixture.repo },
        home: fixture.home,
      });

      expect(userPlan.canonicalScopeRoot).toBe(await realpath(fixture.home));
      expect(userPlan.mutations[0]?.path).toBe(
        join(await realpath(fixture.home), ".claude", "rules", "papercuts.md"),
      );
      expect(userPlan.mutations[0]?.nextContent).toBe(
        renderClaudeInstructions(),
      );
      expect(repoPlan.canonicalScopeRoot).toBe(await realpath(fixture.repo));
      expect(repoPlan.mutations[0]?.path).toBe(
        join(await realpath(fixture.repo), ".claude", "rules", "papercuts.md"),
      );
      expect(await snapshotTree(fixture.base)).toEqual(before);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("generic setup is a snippet-only preview with no mutation", async () => {
    const fixture = await createFixture();

    try {
      const before = await snapshotTree(fixture.base);
      const scope = { kind: "repo", root: fixture.repo } as const;
      const plan = await planSetup({
        harness: "generic",
        action: "install",
        scope,
        home: fixture.home,
      });

      expect(plan).toMatchObject({
        harness: "generic",
        action: "install",
        scope,
        canonicalScopeRoot: await realpath(fixture.repo),
        state: "absent",
        mutations: [],
      });
      expect(plan.snippet).toContain(
        "papercuts add --stdin --source generic",
      );
      expect(await snapshotTree(fixture.base)).toEqual(before);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("classifies current, outdated, malformed, and exact remove plans", async () => {
    const fixture = await createFixture();

    try {
      const target = join(fixture.repo, "AGENTS.md");
      const request = {
        harness: "codex" as const,
        action: "install" as const,
        scope: { kind: "repo" as const, root: fixture.repo },
        home: fixture.home,
      };

      await writeFile(target, `before\n${renderCodexInstructions()}\nafter`);
      const current = await planSetup(request);
      expect(current.state).toBe("current");
      expect(current.mutations).toEqual([]);

      const oldBlock =
        "<!-- papercuts:begin v0 -->\nold managed line\n<!-- papercuts:end -->";
      await writeFile(target, `before\n${oldBlock}\nafter`);
      const outdated = await planSetup(request);
      expect(outdated.state).toBe("outdated");
      expect(outdated.mutations[0]?.nextContent).toBe(
        `before\n${renderCodexInstructions()}\nafter`,
      );
      expect(outdated.mutations[0]?.managedDiff.join("\n")).not.toContain(
        "old managed line",
      );

      await writeFile(target, "before\n<!-- papercuts:begin v1 -->\nbroken");
      const malformed = await planSetup(request);
      expect(malformed.state).toBe("conflict");
      expect(malformed.mutations).toEqual([]);

      const original = "keep these surrounding bytes\r\n";
      await writeFile(target, original);
      const install = await planSetup(request);
      const installed = install.mutations[0]?.nextContent;
      expect(installed).toBeString();
      await writeFile(target, installed!);
      const remove = await planSetup({ ...request, action: "remove" });
      expect(remove.state).toBe("current");
      expect(remove.mutations[0]?.nextContent).toBe(original);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("does not overwrite unrelated content in Claude's owned target", async () => {
    const fixture = await createFixture();

    try {
      const target = join(fixture.home, ".claude", "rules", "papercuts.md");
      await mkdir(join(fixture.home, ".claude", "rules"), { recursive: true });
      await writeFile(target, "unrelated CANARY_CLAUDE_CONTENT\n");
      const before = await snapshotTree(fixture.base);

      const plan = await planSetup({
        harness: "claude-code",
        action: "install",
        scope: { kind: "user" },
        home: fixture.home,
      });

      expect(plan.state).toBe("conflict");
      expect(plan.mutations).toEqual([]);
      expect(JSON.stringify(plan)).not.toContain("CANARY_CLAUDE_CONTENT");
      expect(await snapshotTree(fixture.base)).toEqual(before);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
});
