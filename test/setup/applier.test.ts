import { describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { PapercutsError } from "../../src/domain/errors";
import { sha256Hex } from "../../src/platform/hash";
import { planSetup } from "../../src/setup/adapters";
import { applySetup } from "../../src/setup/applier";
import {
  renderClaudeInstructions,
  renderCodexInstructions,
} from "../../src/setup/content";
import type { SetupPlan } from "../../src/setup/types";

interface Fixture {
  base: string;
  home: string;
  repo: string;
}

async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "papercuts-setup-apply-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(repo, { recursive: true, mode: 0o700 }),
  ]);
  return { base, home, repo };
}

async function expectConflict(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
    throw new Error("expected setup conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(PapercutsError);
    expect(error).toMatchObject({
      code: "setup_conflict",
      exitCode: 4,
      message: "Managed setup content has changed.",
      retryable: false,
    });
    expect(String(error)).not.toContain("CANARY_DO_NOT_ECHO");
  }
}

async function expectMissing(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`expected ${basename(path)} to be missing`);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }
}

async function setupArtifacts(root: string): Promise<readonly string[]> {
  const found: string[] = [];

  async function visit(path: string): Promise<void> {
    let entries;

    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const child = join(path, entry.name);

      if (
        entry.name.startsWith(".papercuts-setup-") ||
        entry.name.startsWith(".papercuts-tmp-")
      ) {
        found.push(child);
      }

      if (entry.isDirectory()) {
        await visit(child);
      }
    }
  }

  await visit(root);
  return found.sort();
}

describe("safe setup application", () => {
  test("rejects a snippet-only generic plan when apply is requested", async () => {
    const fixture = await createFixture();

    try {
      const plan = await planSetup({
        harness: "generic",
        action: "install",
        scope: { kind: "user" },
        home: fixture.home,
      });

      expect(plan.mutations).toEqual([]);
      await expectConflict(applySetup(plan));
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("creates a missing default CODEX_HOME only during apply", async () => {
    const fixture = await createFixture();

    try {
      const codexHome = join(fixture.home, ".codex");
      const plan = await planSetup({
        harness: "codex",
        action: "install",
        scope: { kind: "user" },
        home: fixture.home,
      });

      await expectMissing(codexHome);
      expect(plan.canonicalScopeRoot).toEndWith("/.codex");
      await applySetup(plan);

      expect((await lstat(codexHome)).mode & 0o777).toBe(0o700);
      expect(
        await readFile(join(codexHome, "AGENTS.md"), "utf8"),
      ).toContain("papercuts add --stdin --source codex");
      expect(
        (await lstat(join(codexHome, "AGENTS.md"))).mode & 0o777,
      ).toBe(0o600);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("removes a newly created CODEX_HOME when apply fails", async () => {
    const fixture = await createFixture();

    try {
      const codexHome = join(fixture.home, ".codex");
      const plan = await planSetup({
        harness: "codex",
        action: "install",
        scope: { kind: "user" },
        home: fixture.home,
      });
      let hookObserved = false;

      await expectConflict(
        applySetup(plan, {
          afterTempFileFlush: () => {
            hookObserved = true;
            throw new Error("CANARY_DO_NOT_ECHO injected hook failure");
          },
        }),
      );

      expect(hookObserved).toBeTrue();
      await expectMissing(codexHome);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("does not create missing ancestors outside the canonical scope root", async () => {
    const fixture = await createFixture();

    try {
      const missingAncestor = join(fixture.home, "missing-parent");
      const plan = await planSetup({
        harness: "codex",
        action: "install",
        scope: { kind: "user" },
        home: fixture.home,
        codexHome: join(missingAncestor, "codex-home"),
      });

      await expectConflict(applySetup(plan));
      await expectMissing(missingAncestor);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("does not create a missing repository scope root", async () => {
    const fixture = await createFixture();

    try {
      const missingRepo = join(fixture.base, "missing-repository");
      const plan = await planSetup({
        harness: "codex",
        action: "install",
        scope: { kind: "repo", root: missingRepo },
        home: fixture.home,
      });

      expect(plan.state).toBe("conflict");
      expect(plan.mutations).toEqual([]);
      await expectConflict(applySetup(plan));
      await expectMissing(missingRepo);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("does not create a missing Claude user home root", async () => {
    const fixture = await createFixture();

    try {
      const missingHome = join(fixture.base, "missing-claude-home");
      const plan = await planSetup({
        harness: "claude-code",
        action: "install",
        scope: { kind: "user" },
        home: missingHome,
      });

      expect(plan.state).toBe("conflict");
      expect(plan.mutations).toEqual([]);
      await expectConflict(applySetup(plan));
      await expectMissing(missingHome);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("first apply creates private directories and reapply is a no-op", async () => {
    const fixture = await createFixture();

    try {
      const request = {
        harness: "claude-code" as const,
        action: "install" as const,
        scope: { kind: "user" as const },
        home: fixture.home,
      };
      const plan = await planSetup(request);
      const target = plan.mutations[0]!.path;

      await applySetup(plan);

      expect(await readFile(target, "utf8")).toBe(renderClaudeInstructions());
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
      expect((await lstat(join(fixture.home, ".claude"))).mode & 0o777).toBe(
        0o700,
      );
      expect(
        (await lstat(join(fixture.home, ".claude", "rules"))).mode & 0o777,
      ).toBe(0o700);

      const beforeReapply = await readFile(target);
      const currentPlan = await planSetup(request);
      expect(currentPlan.state).toBe("current");
      expect(currentPlan.mutations).toEqual([]);
      await applySetup(currentPlan);
      expect(await readFile(target)).toEqual(beforeReapply);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("preserves surrounding bytes, CRLF style, and existing mode across apply and undo", async () => {
    const fixture = await createFixture();

    try {
      const target = join(fixture.repo, "AGENTS.md");
      const original = "# Existing\r\nKeep this exact final line";
      await writeFile(target, original, { mode: 0o640 });
      await chmod(target, 0o640);
      const request = {
        harness: "codex" as const,
        action: "install" as const,
        scope: { kind: "repo" as const, root: fixture.repo },
        home: fixture.home,
      };

      const installPlan = await planSetup(request);
      await applySetup(installPlan);
      const installed = await readFile(target, "utf8");

      expect(installed).toStartWith(`${original}\r\n\r\n`);
      expect(installed.replaceAll("\r\n", "")).not.toContain("\n");
      expect((await lstat(target)).mode & 0o777).toBe(0o640);

      const removePlan = await planSetup({ ...request, action: "remove" });
      expect(await readFile(target, "utf8")).toBe(installed);
      await applySetup(removePlan);

      expect(await readFile(target, "utf8")).toBe(original);
      expect((await lstat(target)).mode & 0o777).toBe(0o640);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("preserves a leading UTF-8 BOM byte-exactly across planning, apply, and undo", async () => {
    const fixture = await createFixture();

    try {
      const target = join(fixture.repo, "AGENTS.md");
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const original = Buffer.concat([
        bom,
        Buffer.from("# Existing\r\nKeep this exact final line", "utf8"),
      ]);
      await writeFile(target, original, { mode: 0o640 });
      await chmod(target, 0o640);
      const request = {
        harness: "codex" as const,
        action: "install" as const,
        scope: { kind: "repo" as const, root: fixture.repo },
        home: fixture.home,
      };

      const installPlan = await planSetup(request);
      expect(
        installPlan.mutations[0]?.nextContent?.startsWith("\uFEFF"),
      ).toBeTrue();
      await applySetup(installPlan);
      const installed = await readFile(target);
      expect(installed.subarray(0, original.length)).toEqual(original);
      expect((await lstat(target)).mode & 0o777).toBe(0o640);

      const removePlan = await planSetup({ ...request, action: "remove" });
      await applySetup(removePlan);
      expect(await readFile(target)).toEqual(original);
      expect((await lstat(target)).mode & 0o777).toBe(0o640);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("rejects Codex precedence drift to a new override before apply", async () => {
    const fixture = await createFixture();

    try {
      const mainPath = join(fixture.repo, "AGENTS.md");
      const overridePath = join(fixture.repo, "AGENTS.override.md");
      const main = "# main guidance\n";
      const override = "# newly active override\n";
      await writeFile(mainPath, main);
      const plan = await planSetup({
        harness: "codex",
        action: "install",
        scope: { kind: "repo", root: fixture.repo },
        home: fixture.home,
      });
      await writeFile(overridePath, override);

      await expectConflict(applySetup(plan));
      expect(await readFile(mainPath, "utf8")).toBe(main);
      expect(await readFile(overridePath, "utf8")).toBe(override);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("rejects Codex precedence drift to a new override before rename", async () => {
    const fixture = await createFixture();

    try {
      const mainPath = join(fixture.repo, "AGENTS.md");
      const overridePath = join(fixture.repo, "AGENTS.override.md");
      const main = "# main guidance\n";
      const override = "# active during final check\n";
      await writeFile(mainPath, main);
      const plan = await planSetup({
        harness: "codex",
        action: "install",
        scope: { kind: "repo", root: fixture.repo },
        home: fixture.home,
      });

      await expectConflict(
        applySetup(plan, {
          afterTempFileFlush: async () => {
            await writeFile(overridePath, override);
          },
        }),
      );

      expect(await readFile(mainPath, "utf8")).toBe(main);
      expect(await readFile(overridePath, "utf8")).toBe(override);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("rejects Codex precedence drift from override back to AGENTS.md", async () => {
    const fixture = await createFixture();

    try {
      const mainPath = join(fixture.repo, "AGENTS.md");
      const overridePath = join(fixture.repo, "AGENTS.override.md");
      const main = "# fallback remains untouched\n";
      await writeFile(mainPath, main);
      await writeFile(overridePath, "# initially active override\n");
      const plan = await planSetup({
        harness: "codex",
        action: "install",
        scope: { kind: "repo", root: fixture.repo },
        home: fixture.home,
      });
      await writeFile(overridePath, "\n");

      await expectConflict(applySetup(plan));
      expect(await readFile(mainPath, "utf8")).toBe(main);
      expect(await readFile(overridePath, "utf8")).toBe("\n");
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("rechecks Codex precedence immediately before deleting a managed file", async () => {
    const fixture = await createFixture();

    try {
      const mainPath = join(fixture.repo, "AGENTS.md");
      const overridePath = join(fixture.repo, "AGENTS.override.md");
      await writeFile(mainPath, renderCodexInstructions());
      const plan = await planSetup({
        harness: "codex",
        action: "remove",
        scope: { kind: "repo", root: fixture.repo },
        home: fixture.home,
      });

      await expectConflict(
        applySetup(plan, {
          beforeFinalMutation: async () => {
            await writeFile(overridePath, "# now active\n");
          },
        }),
      );

      expect(await readFile(mainPath, "utf8")).toBe(
        renderCodexInstructions(),
      );
      expect(await readFile(overridePath, "utf8")).toBe("# now active\n");
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("upgrades only an older managed block and preserves surrounding bytes", async () => {
    const fixture = await createFixture();

    try {
      const target = join(fixture.repo, "AGENTS.md");
      const prefix = "before\n";
      const suffix = "\nafter\n";
      const oldBlock =
        "<!-- papercuts:begin v0 -->\nold generated line\n<!-- papercuts:end -->";
      await writeFile(target, `${prefix}${oldBlock}${suffix}`, { mode: 0o644 });
      const plan = await planSetup({
        harness: "codex",
        action: "install",
        scope: { kind: "repo", root: fixture.repo },
        home: fixture.home,
      });

      expect(plan.state).toBe("outdated");
      await applySetup(plan);

      const upgraded = await readFile(target, "utf8");
      expect(upgraded).toStartWith(prefix);
      expect(upgraded).toEndWith(suffix);
      expect(upgraded).toContain("<!-- papercuts:begin v1 -->");
      expect(upgraded).not.toContain("old generated line");
      expect((await lstat(target)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("remove preview writes nothing and remove apply deletes an entirely owned file", async () => {
    const fixture = await createFixture();

    try {
      const request = {
        harness: "claude-code" as const,
        action: "install" as const,
        scope: { kind: "repo" as const, root: fixture.repo },
        home: fixture.home,
      };
      await applySetup(await planSetup(request));
      const target = join(fixture.repo, ".claude", "rules", "papercuts.md");
      const beforePreview = await readFile(target);

      const removePlan = await planSetup({ ...request, action: "remove" });
      expect(removePlan.mutations[0]?.nextContent).toBeNull();
      expect(await readFile(target)).toEqual(beforePreview);
      await applySetup(removePlan);

      await expectMissing(target);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("rejects preimage drift without changing the drifted target", async () => {
    const fixture = await createFixture();

    try {
      const target = join(fixture.repo, "AGENTS.md");
      await writeFile(target, "original\n");
      const plan = await planSetup({
        harness: "codex",
        action: "install",
        scope: { kind: "repo", root: fixture.repo },
        home: fixture.home,
      });
      const drift = "CANARY_DO_NOT_ECHO drifted after preview\n";
      await writeFile(target, drift);

      await expectConflict(applySetup(plan));

      expect(await readFile(target, "utf8")).toBe(drift);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("rejects target and parent symlinks plus non-regular targets without mutation", async () => {
    for (const scenario of ["target-symlink", "parent-symlink", "directory"] as const) {
      const fixture = await createFixture();

      try {
        const request = {
          harness: "claude-code" as const,
          action: "install" as const,
          scope: { kind: "user" as const },
          home: fixture.home,
        };
        const plan = await planSetup(request);
        const target = plan.mutations[0]!.path;
        const outside = join(fixture.base, `outside-${scenario}`);
        await mkdir(outside, { recursive: true });

        if (scenario === "target-symlink") {
          const outsideFile = join(outside, "outside.md");
          await writeFile(outsideFile, "outside stays unchanged\n");
          await mkdir(dirname(target), { recursive: true });
          await symlink(outsideFile, target);
          await expectConflict(applySetup(plan));
          expect(await readFile(outsideFile, "utf8")).toBe(
            "outside stays unchanged\n",
          );
          expect((await lstat(target)).isSymbolicLink()).toBeTrue();
        } else if (scenario === "parent-symlink") {
          await symlink(outside, join(fixture.home, ".claude"));
          await expectConflict(applySetup(plan));
          await expectMissing(join(outside, "rules", "papercuts.md"));
        } else {
          await mkdir(target, { recursive: true });
          await expectConflict(applySetup(plan));
          expect((await lstat(target)).isDirectory()).toBeTrue();
        }

        expect(await setupArtifacts(fixture.base)).toEqual([]);
      } finally {
        await rm(fixture.base, { recursive: true, force: true });
      }
    }
  });

  test("rejects malformed plans and scope escapes with sanitized conflicts", async () => {
    const fixture = await createFixture();

    try {
      const malformedTarget = join(fixture.repo, "AGENTS.md");
      await writeFile(
        malformedTarget,
        "<!-- papercuts:begin v1 -->\nCANARY_DO_NOT_ECHO malformed",
      );
      const malformedPlan = await planSetup({
        harness: "codex",
        action: "install",
        scope: { kind: "repo", root: fixture.repo },
        home: fixture.home,
      });
      expect(malformedPlan.state).toBe("conflict");
      await expectConflict(applySetup(malformedPlan));
      expect(await readFile(malformedTarget, "utf8")).toContain(
        "CANARY_DO_NOT_ECHO",
      );

      const escapedTarget = join(fixture.base, "escaped.md");
      const escapedPlan: SetupPlan = {
        harness: "codex",
        action: "install",
        scope: { kind: "repo", root: fixture.repo },
        canonicalScopeRoot: fixture.repo,
        state: "absent",
        mutations: [
          {
            path: escapedTarget,
            expectedSha256: null,
            nextContent: renderClaudeInstructions(),
            createMode: 0o600,
            managedDiff: [],
          },
        ],
      };
      await expectConflict(applySetup(escapedPlan));
      await expectMissing(escapedTarget);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("rejects an unknown managed block version during semantic revalidation", async () => {
    const fixture = await createFixture();

    try {
      const root = await realpath(fixture.repo);
      const target = join(root, "AGENTS.md");
      const future =
        "<!-- papercuts:begin v2 -->\nfuture managed content\n<!-- papercuts:end -->";
      await writeFile(target, future);
      const plan: SetupPlan = {
        harness: "codex",
        action: "install",
        scope: { kind: "repo", root: fixture.repo },
        canonicalScopeRoot: root,
        state: "outdated",
        mutations: [
          {
            path: target,
            expectedSha256: sha256Hex(future),
            nextContent: renderCodexInstructions(),
            createMode: 0o600,
            managedDiff: [],
          },
        ],
      };

      await expectConflict(applySetup(plan));
      expect(await readFile(target, "utf8")).toBe(future);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("rejects a multi-mutation v1 plan before writing any target", async () => {
    const fixture = await createFixture();

    try {
      const root = await realpath(fixture.repo);
      const first = join(root, "AGENTS.md");
      const second = join(root, "SECOND.md");
      const plan: SetupPlan = {
        harness: "codex",
        action: "install",
        scope: { kind: "repo", root: fixture.repo },
        canonicalScopeRoot: root,
        state: "absent",
        mutations: [first, second].map((path) => ({
          path,
          expectedSha256: null,
          nextContent: renderCodexInstructions(),
          createMode: 0o600,
          managedDiff: [],
        })),
      };

      await expectConflict(applySetup(plan));
      await expectMissing(first);
      await expectMissing(second);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("reports success after a post-rename directory sync failure", async () => {
    const fixture = await createFixture();

    try {
      const plan = await planSetup({
        harness: "claude-code",
        action: "install",
        scope: { kind: "user" },
        home: fixture.home,
      });
      const target = plan.mutations[0]!.path;
      let syncAttempted = false;

      await applySetup(plan, {
        syncDirectory: async () => {
          syncAttempted = true;
          throw new Error("CANARY_DO_NOT_ECHO injected directory sync failure");
        },
      });

      expect(syncAttempted).toBeTrue();
      expect(await readFile(target, "utf8")).toBe(renderClaudeInstructions());
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("reports success after a post-delete directory sync failure", async () => {
    const fixture = await createFixture();

    try {
      const target = join(fixture.repo, ".claude", "rules", "papercuts.md");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, renderClaudeInstructions(), { mode: 0o600 });
      const plan = await planSetup({
        harness: "claude-code",
        action: "remove",
        scope: { kind: "repo", root: fixture.repo },
        home: fixture.home,
      });
      let syncAttempted = false;

      await applySetup(plan, {
        syncDirectory: async () => {
          syncAttempted = true;
          throw new Error("CANARY_DO_NOT_ECHO injected directory sync failure");
        },
      });

      expect(syncAttempted).toBeTrue();
      await expectMissing(target);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("rechecks the preimage after temp flush and never renames over new drift", async () => {
    const fixture = await createFixture();

    try {
      const target = join(fixture.repo, "AGENTS.md");
      await writeFile(target, "before hook\n", { mode: 0o640 });
      const plan = await planSetup({
        harness: "codex",
        action: "install",
        scope: { kind: "repo", root: fixture.repo },
        home: fixture.home,
      });
      const plannedTarget = plan.mutations[0]!.path;
      const drift = "CANARY_DO_NOT_ECHO changed after temp flush\n";
      let hookObserved = false;

      await expectConflict(
        applySetup(plan, {
          afterTempFileFlush: async ({ mutation, tempPath }) => {
            hookObserved = true;
            expect(dirname(tempPath)).toBe(dirname(plannedTarget));
            expect((await lstat(tempPath)).isFile()).toBeTrue();
            expect(mutation.nextContent).not.toBeNull();
            expect(await readFile(tempPath, "utf8")).toBe(
              mutation.nextContent!,
            );
            await writeFile(target, drift);
          },
        }),
      );

      expect(hookObserved).toBeTrue();
      expect(await readFile(target, "utf8")).toBe(drift);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("serializes two cooperative applies with a target-hash lock and cleans it", async () => {
    const fixture = await createFixture();

    try {
      const request = {
        harness: "codex" as const,
        action: "install" as const,
        scope: { kind: "repo" as const, root: fixture.repo },
        home: fixture.home,
      };
      const firstPlan = await planSetup(request);
      const secondPlan = await planSetup(request);
      const target = firstPlan.mutations[0]!.path;
      const lockPath = join(
        fixture.repo,
        `.papercuts-setup-${sha256Hex(target).slice(0, 16)}.lock`,
      );
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reachedHook!: () => void;
      const hookReached = new Promise<void>((resolve) => {
        reachedHook = resolve;
      });

      const first = applySetup(firstPlan, {
        afterTempFileFlush: async () => {
          expect((await lstat(lockPath)).isFile()).toBeTrue();
          reachedHook();
          await gate;
        },
      });
      await hookReached;
      const second = applySetup(secondPlan);
      await Bun.sleep(20);
      release();
      const results = await Promise.allSettled([first, second]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
        1,
      );
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status).toBe("rejected");
      if (rejected?.status === "rejected") {
        expect(rejected.reason).toBeInstanceOf(PapercutsError);
        expect(rejected.reason).toMatchObject({ code: "setup_conflict" });
      }
      expect(await readFile(target, "utf8")).toContain(
        "papercuts add --stdin --source codex",
      );
      await expectMissing(lockPath);
      expect(await setupArtifacts(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
});
