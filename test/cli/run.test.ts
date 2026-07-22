import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Papercut,
  PapercutQuery,
  PapercutStore,
  ResolvedRepoContext,
  ScreenedText,
} from "../../src/domain/types";
import { PapercutsError } from "../../src/domain/errors";
import type { SetupPlan, SetupRequest } from "../../src/setup/types";
import { runCli, type CliRuntime } from "../../src/cli/run";

const NOW_MS = Date.UTC(2026, 6, 10, 12, 0, 0);
const NOW_ISO = "2026-07-10T12:00:00.000Z";
const FIXED_UUID = "00000000-0000-4000-8000-000000000000";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function screened(value: string): ScreenedText {
  return value as ScreenedText;
}

function demoRepoContext(): ResolvedRepoContext {
  return {
    context: {
      key: "repo-key-1",
      keyKind: "remote",
      displayName: screened("demo-repo"),
      root: screened("/repo/demo-repo"),
      cwdRelative: screened("."),
      branch: screened("main"),
      head: screened("a".repeat(40)),
    },
    redactionCount: 0,
  };
}

function makePapercut(overrides: Partial<Papercut> = {}): Papercut {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    createdAtMs: NOW_MS - 60_000,
    body: screened("an example papercut body"),
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

function makePlan(overrides: Partial<SetupPlan> = {}): SetupPlan {
  return {
    harness: "codex",
    action: "install",
    scope: { kind: "user" },
    canonicalScopeRoot: "/home/user/.codex",
    state: "absent",
    mutations: [
      {
        path: "/home/user/.codex/AGENTS.md",
        expectedSha256: null,
        nextContent: "managed content",
        createMode: 0o600,
        managedDiff: ["+ AGENTS.md", "+ managed line"],
      },
    ],
    ...overrides,
  };
}

interface HarnessOptions {
  stdinChunks?: readonly Uint8Array[];
  repoContext?: ResolvedRepoContext | null;
  repoError?: unknown;
  listResults?: readonly Papercut[];
  appendError?: unknown;
  setResolvedResult?: boolean;
  plan?: SetupPlan;
  planError?: unknown;
  environment?: Partial<CliRuntime["environment"]>;
}

function createHarness(options: HarnessOptions = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const appended: Papercut[] = [];
  const resolutions: Array<{ id: string; resolvedAtMs: number | null }> = [];
  const queries: PapercutQuery[] = [];
  const openedPaths: string[] = [];
  const planRequests: SetupRequest[] = [];
  const appliedPlans: SetupPlan[] = [];
  let openCalls = 0;
  let closeCalls = 0;
  let resolveCalls = 0;

  const store: PapercutStore = {
    append(record) {
      if (options.appendError !== undefined) {
        throw options.appendError;
      }
      appended.push(record);
    },
    list(query) {
      queries.push(query);
      return options.listResults ?? [];
    },
    setResolved(id, resolvedAtMs) {
      resolutions.push({ id, resolvedAtMs });
      return options.setResolvedResult ?? true;
    },
    health() {
      return {
        schemaVersion: 1,
        integrity: "ok",
        sqliteVersion: "3.50.0",
        lockAvailable: true,
      };
    },
    close() {
      closeCalls += 1;
    },
  };

  async function* stdin(): AsyncGenerator<Uint8Array> {
    for (const chunk of options.stdinChunks ?? []) {
      yield chunk;
    }
  }

  const runtime: CliRuntime = {
    io: {
      stdin: stdin(),
      writeStdout(text) {
        stdout.push(text);
      },
      writeStderr(text) {
        stderr.push(text);
      },
      stdoutIsTty: false,
    },
    environment: {
      cwd: "/work/demo",
      home: "/home/user",
      codexHome: "/home/user/.codex",
      ...options.environment,
    },
    openStore(path) {
      openCalls += 1;
      openedPaths.push(path);
      return store;
    },
    async resolveRepoContext() {
      resolveCalls += 1;
      if (options.repoError !== undefined) {
        throw options.repoError;
      }
      return options.repoContext ?? null;
    },
    async planSetup(request) {
      planRequests.push(request);
      if (options.planError !== undefined) {
        throw options.planError;
      }
      return options.plan ?? makePlan();
    },
    async applySetup(plan) {
      appliedPlans.push(plan);
    },
    now: () => NOW_MS,
    randomUUID: () => FIXED_UUID,
    clientVersion: "0.1.0",
    runtimeVersion: "test-runtime",
  };

  return {
    runtime,
    stdoutText: () => stdout.join(""),
    stderrText: () => stderr.join(""),
    appended,
    resolutions,
    queries,
    openedPaths,
    planRequests,
    appliedPlans,
    get openCalls() {
      return openCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
    get resolveCalls() {
      return resolveCalls;
    },
  };
}

function parseEnvelope(stdoutText: string): Record<string, unknown> {
  expect(stdoutText.endsWith("\n")).toBe(true);
  expect(stdoutText.slice(0, -1)).not.toContain("\n");
  return JSON.parse(stdoutText) as Record<string, unknown>;
}

describe("runCli help and version", () => {
  test("no arguments prints usage without opening the store", async () => {
    const harness = createHarness();

    const exitCode = await runCli([], harness.runtime);

    expect(exitCode).toBe(0);
    expect(harness.stdoutText()).toContain("papercuts");
    expect(harness.stderrText()).toBe("");
    expect(harness.openCalls).toBe(0);
  });

  test("--help --json returns {topic:null, usage}", async () => {
    const harness = createHarness();

    const exitCode = await runCli(["--help", "--json"], harness.runtime);
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    expect(envelope["ok"]).toBe(true);
    expect(envelope["command"]).toBe("help");
    const data = envelope["data"] as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(["topic", "usage"]);
    expect(data["topic"]).toBeNull();
    expect(typeof data["usage"]).toBe("string");
    expect(harness.stderrText()).toBe("");
    expect(harness.openCalls).toBe(0);
  });

  test("add --help --json returns the add topic", async () => {
    const harness = createHarness();

    const exitCode = await runCli(["add", "--help", "--json"], harness.runtime);
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    expect((envelope["data"] as Record<string, unknown>)["topic"]).toBe("add");
    expect(harness.openCalls).toBe(0);
  });

  test("--version prints only the client version in human mode", async () => {
    const harness = createHarness();

    const exitCode = await runCli(["--version"], harness.runtime);

    expect(exitCode).toBe(0);
    expect(harness.stdoutText()).toBe("0.1.0\n");
    expect(harness.stderrText()).toBe("");
    expect(harness.openCalls).toBe(0);
  });

  test("--version --json returns {version}", async () => {
    const harness = createHarness();

    const exitCode = await runCli(["--version", "--json"], harness.runtime);
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    expect(envelope["command"]).toBe("version");
    expect(envelope["data"]).toEqual({ version: "0.1.0" });
    expect(harness.openCalls).toBe(0);
  });
});

describe("runCli add", () => {
  test("records a positional message and emits the fixed JSON receipt shape", async () => {
    const harness = createHarness({ repoContext: demoRepoContext() });

    const exitCode = await runCli(
      ["add", "hit a papercut", "--json"],
      harness.runtime,
    );
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    expect(envelope["ok"]).toBe(true);
    expect(envelope["command"]).toBe("add");
    const data = envelope["data"] as Record<string, unknown>;
    expect(Object.keys(data)).toEqual([
      "id",
      "createdAt",
      "source",
      "repository",
      "redactionCount",
    ]);
    expect(data["id"]).toBe(FIXED_UUID);
    expect(data["createdAt"]).toBe(NOW_ISO);
    expect(data["source"]).toBe("manual");
    expect(data["repository"]).toEqual({ name: "demo-repo" });
    expect(data["redactionCount"]).toBe(0);
    expect(envelope["warnings"]).toEqual([]);
    expect(harness.stdoutText()).not.toContain("hit a papercut");
    expect(harness.stderrText()).toBe("");
    expect(harness.openCalls).toBe(1);
    expect(harness.closeCalls).toBe(1);
    expect(harness.appended).toHaveLength(1);
    expect(String(harness.appended[0]!.body)).toBe("hit a papercut");
  });

  test("records a message read from stdin", async () => {
    const harness = createHarness({
      stdinChunks: [
        new TextEncoder().encode("from "),
        new TextEncoder().encode("stdin"),
      ],
      repoContext: null,
    });

    const exitCode = await runCli(
      ["add", "--stdin", "--source", "codex", "--json"],
      harness.runtime,
    );

    expect(exitCode).toBe(0);
    expect(harness.appended).toHaveLength(1);
    expect(String(harness.appended[0]!.body)).toBe("from stdin");
    expect(harness.appended[0]!.source).toBe("codex");
    expect(harness.stdoutText()).not.toContain("from stdin");
  });

  test("human mode prints the record id and safe context, never the body", async () => {
    const harness = createHarness({ repoContext: demoRepoContext() });

    const exitCode = await runCli(["add", "hit a papercut"], harness.runtime);

    expect(exitCode).toBe(0);
    expect(harness.stdoutText()).toContain(FIXED_UUID);
    expect(harness.stdoutText()).toContain("demo-repo");
    expect(harness.stdoutText()).not.toContain("hit a papercut");
    expect(harness.stderrText()).toBe("");
  });

  test("a busy store surfaces as a retryable JSON error with an empty stderr", async () => {
    const harness = createHarness({
      repoContext: null,
      appendError: new PapercutsError("store_busy"),
    });

    const exitCode = await runCli(["add", "a body", "--json"], harness.runtime);
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(5);
    expect(envelope["ok"]).toBe(false);
    expect(envelope["error"]).toEqual({
      code: "store_busy",
      message: "The papercuts store is busy; try again.",
      retryable: true,
    });
    expect(harness.stderrText()).toBe("");
    expect(harness.closeCalls).toBe(1);
  });

  test("a busy store surfaces on stderr in human mode and still closes the store", async () => {
    const harness = createHarness({
      repoContext: null,
      appendError: new PapercutsError("store_busy"),
    });

    const exitCode = await runCli(["add", "a body"], harness.runtime);

    expect(exitCode).toBe(5);
    expect(harness.stdoutText()).toBe("");
    expect(harness.stderrText()).toBe(
      "The papercuts store is busy; try again.\n",
    );
    expect(harness.closeCalls).toBe(1);
  });

  test("a failed repository resolution degrades to a warning, not a failure", async () => {
    const harness = createHarness({
      repoError: new PapercutsError("internal_error"),
    });

    const exitCode = await runCli(["add", "a body", "--json"], harness.runtime);
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    expect(envelope["ok"]).toBe(true);
    expect((envelope["data"] as Record<string, unknown>)["repository"]).toBeNull();
    expect(envelope["warnings"]).toHaveLength(1);
  });
});

describe("runCli never opens the store for pre-store failures and previews", () => {
  const oversized = new Uint8Array(65_537).fill(97);
  const cases: readonly {
    name: string;
    argv: readonly string[];
    stdinChunks?: readonly Uint8Array[];
    exitCode: number;
  }[] = [
    { name: "help", argv: [], exitCode: 0 },
    { name: "version", argv: ["--version"], exitCode: 0 },
    { name: "setup preview", argv: ["setup", "codex"], exitCode: 0 },
    {
      name: "generic setup preview",
      argv: ["setup", "generic"],
      exitCode: 0,
    },
    {
      name: "generic --apply",
      argv: ["setup", "generic", "--apply"],
      exitCode: 4,
    },
    {
      name: "empty stdin",
      argv: ["add", "--stdin"],
      stdinChunks: [],
      exitCode: 2,
    },
    {
      name: "NUL stdin",
      argv: ["add", "--stdin"],
      stdinChunks: [new Uint8Array([97, 0, 98])],
      exitCode: 2,
    },
    {
      name: "malformed UTF-8 stdin",
      argv: ["add", "--stdin"],
      stdinChunks: [new Uint8Array([0xff])],
      exitCode: 2,
    },
    {
      name: "oversized stdin",
      argv: ["add", "--stdin"],
      stdinChunks: [oversized],
      exitCode: 2,
    },
    {
      name: "invalid source",
      argv: ["add", "a body", "--source", "bogus"],
      exitCode: 2,
    },
    {
      name: "invalid model",
      argv: ["add", "a body", "--model", "x".repeat(300)],
      exitCode: 2,
    },
    {
      name: "invalid category",
      argv: ["add", "a body", "--category", "x".repeat(65)],
      exitCode: 2,
    },
    {
      name: "invalid tag",
      argv: ["add", "a body", "--tag", "   "],
      exitCode: 2,
    },
    {
      // 59 raw bytes pass the parse bound; the redaction marker grows the
      // tag to 69 bytes, past its 64-byte bound, inside the capture layer.
      name: "tag that grows past its bound after redaction",
      argv: ["add", "a body", "--tag", `${"b".repeat(44)} Authorization:`],
      exitCode: 2,
    },
    {
      // 65,536 raw bytes pass the parse bound; the redaction marker grows
      // the body to 65,546 bytes, past its bound, inside the capture layer.
      name: "body that grows past its bound after redaction",
      argv: ["add", `${"a".repeat(65_521)} Authorization:`],
      exitCode: 2,
    },
    {
      name: "list --repo current outside Git",
      argv: ["list", "--repo", "current"],
      exitCode: 2,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const harness = createHarness({
        repoContext: null,
        ...(testCase.stdinChunks !== undefined
          ? { stdinChunks: testCase.stdinChunks }
          : {}),
        plan: makePlan({ snippet: "portable snippet" }),
      });

      const exitCode = await runCli(testCase.argv, harness.runtime);

      expect(exitCode).toBe(testCase.exitCode);
      expect(harness.openCalls).toBe(0);
    });
  }
});

describe("runCli list", () => {
  test("auto scope inside Git resolves to the current repository", async () => {
    const record = makePapercut({
      model: screened("model-x"),
      category: screened("workflow"),
      tags: [screened("cli")],
      repo: demoRepoContext().context,
    });
    const harness = createHarness({
      repoContext: demoRepoContext(),
      listResults: [record],
    });

    const exitCode = await runCli(["list", "--json"], harness.runtime);
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    expect(envelope["command"]).toBe("list");
    const data = envelope["data"] as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(["scope", "records"]);
    expect(data["scope"]).toEqual({
      kind: "current",
      repository: { name: "demo-repo" },
    });

    const records = data["records"] as Record<string, unknown>[];
    expect(records).toHaveLength(1);
    expect(Object.keys(records[0]!)).toEqual([
      "id",
      "createdAt",
      "body",
      "source",
      "model",
      "category",
      "tags",
      "repository",
      "redactionCount",
    ]);
    expect(records[0]!["repository"]).toEqual({
      name: "demo-repo",
      branch: "main",
      cwdRelative: ".",
    });

    expect(harness.queries).toHaveLength(1);
    expect(harness.queries[0]).toEqual({
      repoKey: "repo-key-1",
      order: "newest",
      limit: 50,
    });
    expect(harness.closeCalls).toBe(1);
  });

  test("auto scope outside Git resolves to all repositories", async () => {
    const harness = createHarness({ repoContext: null });

    const exitCode = await runCli(["list", "--json"], harness.runtime);
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    expect((envelope["data"] as Record<string, unknown>)["scope"]).toEqual({
      kind: "all",
    });
    expect(harness.queries[0]).toEqual({ order: "newest", limit: 50 });
  });

  test("--repo all never resolves repository context", async () => {
    const harness = createHarness({ repoContext: demoRepoContext() });

    const exitCode = await runCli(
      ["list", "--repo", "all", "--json"],
      harness.runtime,
    );

    expect(exitCode).toBe(0);
    expect(harness.resolveCalls).toBe(0);
  });

  test("--since and --limit shape the store query", async () => {
    const harness = createHarness({ repoContext: null });

    const exitCode = await runCli(
      ["list", "--since", "7d", "--limit", "5", "--json"],
      harness.runtime,
    );

    expect(exitCode).toBe(0);
    expect(harness.queries[0]).toEqual({
      sinceMs: NOW_MS - 604_800_000,
      order: "newest",
      limit: 5,
    });
  });

  test("passes --include-resolved through to the store query", async () => {
    const harness = createHarness({ repoContext: null });

    const exitCode = await runCli(
      ["list", "--include-resolved", "--json"],
      harness.runtime,
    );

    expect(exitCode).toBe(0);
    expect(harness.queries[0]).toEqual({
      order: "newest",
      limit: 50,
      includeResolved: true,
    });
  });

  test("human mode renders the list view with the resolved scope", async () => {
    const harness = createHarness({
      repoContext: null,
      listResults: [makePapercut()],
    });

    const exitCode = await runCli(["list"], harness.runtime);

    expect(exitCode).toBe(0);
    expect(harness.stdoutText()).toContain("all repositories");
    expect(harness.stdoutText()).toContain("an example papercut body");
    expect(harness.stderrText()).toBe("");
  });
});

describe("runCli lifecycle", () => {
  test("resolves and reopens a papercut with a stable JSON payload", async () => {
    const harness = createHarness();

    const resolveExitCode = await runCli(
      ["resolve", FIXED_UUID, "--json"],
      harness.runtime,
    );
    const resolveEnvelope = parseEnvelope(harness.stdoutText());

    expect(resolveExitCode).toBe(0);
    expect(resolveEnvelope["command"]).toBe("resolve");
    expect(resolveEnvelope["data"]).toEqual({ id: FIXED_UUID, resolved: true });
    expect(harness.resolutions).toEqual([
      { id: FIXED_UUID, resolvedAtMs: NOW_MS },
    ]);
  });

  test("returns a sanitized not-found error for an unknown id", async () => {
    const harness = createHarness({ setResolvedResult: false });

    const exitCode = await runCli(["reopen", FIXED_UUID], harness.runtime);

    expect(exitCode).toBe(3);
    expect(harness.stderrText()).toBe("The requested item was not found.\n");
    expect(harness.closeCalls).toBe(1);
  });
});

describe("runCli stats", () => {
  test("emits the fixed stats payload shape", async () => {
    const harness = createHarness({
      repoContext: null,
      listResults: [makePapercut(), makePapercut({ id: FIXED_UUID })],
    });

    const exitCode = await runCli(["stats", "--json"], harness.runtime);
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    expect(envelope["command"]).toBe("stats");
    const data = envelope["data"] as Record<string, unknown>;
    expect(Object.keys(data)).toEqual([
      "scope",
      "total",
      "firstAt",
      "lastAt",
      "byDay",
      "bySource",
      "byRepository",
      "byCategory",
      "redactedRecordCount",
      "replacementCount",
      "exactRepeats",
    ]);
    expect(data["scope"]).toEqual({ kind: "all" });
    expect(data["total"]).toBe(2);
    expect(harness.queries[0]).not.toHaveProperty("limit");
    expect(harness.queries[0]).toEqual({ order: "oldest" });
    expect(harness.closeCalls).toBe(1);
  });

  test("queries the store oldest-first with the --since window and no limit", async () => {
    const harness = createHarness({ repoContext: null });

    const exitCode = await runCli(
      ["stats", "--since", "24h", "--json"],
      harness.runtime,
    );

    expect(exitCode).toBe(0);
    expect(harness.queries).toHaveLength(1);
    expect(harness.queries[0]).toEqual({
      sinceMs: NOW_MS - 86_400_000,
      order: "oldest",
    });
  });
});

describe("runCli export", () => {
  test("exports Markdown to stdout by default in JSON mode", async () => {
    const harness = createHarness({
      repoContext: null,
      listResults: [makePapercut()],
    });

    const exitCode = await runCli(["export", "--json"], harness.runtime);
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    expect(envelope["command"]).toBe("export");
    const data = envelope["data"] as Record<string, unknown>;
    expect(Object.keys(data)).toEqual([
      "scope",
      "recordCount",
      "outputPath",
      "markdown",
    ]);
    expect(data["scope"]).toEqual({ kind: "all" });
    expect(data["recordCount"]).toBe(1);
    expect(data["outputPath"]).toBeNull();
    expect(String(data["markdown"])).toContain("# Papercuts");
    expect(harness.queries[0]).toEqual({ order: "oldest" });
  });

  test("queries the store oldest-first with the --since window and no limit", async () => {
    const harness = createHarness({ repoContext: null });

    const exitCode = await runCli(
      ["export", "--since", "7d", "--json"],
      harness.runtime,
    );

    expect(exitCode).toBe(0);
    expect(harness.queries).toHaveLength(1);
    expect(harness.queries[0]).toEqual({
      sinceMs: NOW_MS - 604_800_000,
      order: "oldest",
    });
  });

  test("human mode writes the Markdown document to stdout", async () => {
    const harness = createHarness({
      repoContext: null,
      listResults: [makePapercut()],
    });

    const exitCode = await runCli(["export"], harness.runtime);

    expect(exitCode).toBe(0);
    expect(harness.stdoutText()).toStartWith("# Papercuts");
    expect(harness.stderrText()).toBe("");
  });

  test("--output creates a new file exclusively and reports its path", async () => {
    const directory = makeTempDir("papercuts-run-export-");
    const outputPath = join(directory, "export.md");
    const harness = createHarness({
      repoContext: null,
      listResults: [makePapercut()],
    });

    const exitCode = await runCli(
      ["export", "--output", outputPath, "--json"],
      harness.runtime,
    );
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    const data = envelope["data"] as Record<string, unknown>;
    expect(data["outputPath"]).toBe(outputPath);
    expect(data["markdown"]).toBeNull();
    expect(readFileSync(outputPath, "utf8")).toContain("# Papercuts");
  });

  test("--output refuses an existing file without --force", async () => {
    const directory = makeTempDir("papercuts-run-export-");
    const outputPath = join(directory, "export.md");
    writeFileSync(outputPath, "keep me");
    const harness = createHarness({ repoContext: null, listResults: [] });

    const exitCode = await runCli(
      ["export", "--output", outputPath, "--json"],
      harness.runtime,
    );
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(2);
    expect(envelope["ok"]).toBe(false);
    expect((envelope["error"] as Record<string, unknown>)["code"]).toBe(
      "invalid_input",
    );
    expect(readFileSync(outputPath, "utf8")).toBe("keep me");
    expect(harness.stderrText()).toBe("");
  });

  test("--output --force atomically replaces an existing file", async () => {
    const directory = makeTempDir("papercuts-run-export-");
    const outputPath = join(directory, "export.md");
    writeFileSync(outputPath, "old content");
    const harness = createHarness({
      repoContext: null,
      listResults: [makePapercut()],
    });

    const exitCode = await runCli(
      ["export", "--output", outputPath, "--force"],
      harness.runtime,
    );

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain("# Papercuts");
    expect(harness.stdoutText()).not.toContain("# Papercuts");
    expect(harness.stdoutText()).toContain("all repositories");
  });
});

describe("runCli setup", () => {
  test("preview plans without applying and reports safe plan facts", async () => {
    const harness = createHarness();

    const exitCode = await runCli(["setup", "codex", "--json"], harness.runtime);
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    expect(envelope["command"]).toBe("setup");
    expect(harness.planRequests).toHaveLength(1);
    expect(harness.planRequests[0]).toEqual({
      harness: "codex",
      action: "install",
      scope: { kind: "user" },
      home: "/home/user",
      codexHome: "/home/user/.codex",
    });
    expect(harness.appliedPlans).toHaveLength(0);
    expect(harness.openCalls).toBe(0);

    const data = envelope["data"] as Record<string, unknown>;
    expect(Object.keys(data)).toEqual([
      "harness",
      "action",
      "scope",
      "state",
      "mutations",
      "snippet",
    ]);
    expect(data["harness"]).toBe("codex");
    expect(data["action"]).toBe("install");
    expect(data["scope"]).toBe("user");
    expect(data["state"]).toBe("absent");
    expect(data["snippet"]).toBeNull();

    const mutations = data["mutations"] as Record<string, unknown>[];
    expect(mutations).toHaveLength(1);
    expect(Object.keys(mutations[0]!)).toEqual(["path", "managedDiff"]);
    expect(mutations[0]!["path"]).toBe("/home/user/.codex/AGENTS.md");
    expect(mutations[0]!["managedDiff"]).toEqual([
      "+ AGENTS.md",
      "+ managed line",
    ]);
  });

  test("--undo plans a removal", async () => {
    const harness = createHarness();

    const exitCode = await runCli(
      ["setup", "codex", "--undo", "--json"],
      harness.runtime,
    );

    expect(exitCode).toBe(0);
    expect(harness.planRequests[0]!.action).toBe("remove");
    expect(harness.appliedPlans).toHaveLength(0);
  });

  test("--apply routes the plan through applySetup", async () => {
    const harness = createHarness();

    const exitCode = await runCli(
      ["setup", "codex", "--apply", "--json"],
      harness.runtime,
    );

    expect(exitCode).toBe(0);
    expect(harness.appliedPlans).toHaveLength(1);
    expect(harness.appliedPlans[0]).toEqual(makePlan());
  });

  test("--apply on a conflicting plan fails without applying", async () => {
    const harness = createHarness({
      plan: makePlan({ state: "conflict", mutations: [] }),
    });

    const exitCode = await runCli(
      ["setup", "codex", "--apply", "--json"],
      harness.runtime,
    );
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(4);
    expect((envelope["error"] as Record<string, unknown>)["code"]).toBe(
      "setup_conflict",
    );
    expect(harness.appliedPlans).toHaveLength(0);
    expect(harness.stderrText()).toBe("");
  });

  test("generic preview reports the portable snippet", async () => {
    const harness = createHarness({
      plan: makePlan({
        harness: "generic",
        state: "absent",
        mutations: [],
        snippet: "portable snippet",
      }),
    });

    const exitCode = await runCli(
      ["setup", "generic", "--json"],
      harness.runtime,
    );
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    expect((envelope["data"] as Record<string, unknown>)["snippet"]).toBe(
      "portable snippet",
    );
  });

  test("generic --apply is rejected before planning", async () => {
    const harness = createHarness();

    const exitCode = await runCli(
      ["setup", "generic", "--apply", "--json"],
      harness.runtime,
    );
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(4);
    expect((envelope["error"] as Record<string, unknown>)["code"]).toBe(
      "setup_conflict",
    );
    expect(harness.planRequests).toHaveLength(0);
    expect(harness.appliedPlans).toHaveLength(0);
  });

  test("--scope repo targets the resolved repository root", async () => {
    const harness = createHarness({ repoContext: demoRepoContext() });

    const exitCode = await runCli(
      ["setup", "claude-code", "--scope", "repo", "--json"],
      harness.runtime,
    );

    expect(exitCode).toBe(0);
    expect(harness.planRequests[0]!.scope).toEqual({
      kind: "repo",
      root: "/repo/demo-repo",
    });
  });

  test("--scope repo outside Git is a validation error", async () => {
    const harness = createHarness({ repoContext: null });

    const exitCode = await runCli(
      ["setup", "claude-code", "--scope", "repo", "--json"],
      harness.runtime,
    );

    expect(exitCode).toBe(2);
    expect(harness.planRequests).toHaveLength(0);
  });
});

describe("runCli doctor", () => {
  test("emits the fixed {ok, checks} payload and exits by report health", async () => {
    const home = makeTempDir("papercuts-run-doctor-");
    const harness = createHarness({
      repoContext: null,
      environment: { home, cwd: home },
    });

    const exitCode = await runCli(["doctor", "--json"], harness.runtime);
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(0);
    expect(envelope["command"]).toBe("doctor");
    const data = envelope["data"] as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(["ok", "checks"]);
    expect(data["ok"]).toBe(true);
    const checks = data["checks"] as Record<string, unknown>[];
    expect(checks.map((check) => check["name"])).toEqual([
      "path",
      "cli-version",
      "runtime-version",
      "data-directory",
      "database-file",
      "sqlite-version",
      "schema-version",
      "integrity",
      "write-lock",
      "git-attribution",
      "setup-codex-user",
      "setup-claude-user",
    ]);
    // The fresh temporary home has no database, so the store never opens.
    expect(harness.openCalls).toBe(0);
  });

  test("human mode prints one line per check", async () => {
    const home = makeTempDir("papercuts-run-doctor-");
    const harness = createHarness({
      repoContext: null,
      environment: { home, cwd: home },
    });

    const exitCode = await runCli(["doctor"], harness.runtime);

    expect(exitCode).toBe(0);
    expect(harness.stdoutText()).toContain("cli-version");
    expect(harness.stdoutText()).toContain("papercuts 0.1.0");
    expect(harness.stderrText()).toBe("");
  });
});

describe("runCli environment and error routing", () => {
  test("opens the store under the default external data directory", async () => {
    const harness = createHarness({ repoContext: null });

    await runCli(["add", "a body", "--json"], harness.runtime);

    expect(harness.openedPaths).toEqual([
      "/home/user/Library/Application Support/papercuts/papercuts.sqlite3",
    ]);
  });

  test("PAPERCUTS_HOME overrides the data directory", async () => {
    const harness = createHarness({
      repoContext: null,
      environment: { papercutsHome: "/custom/data" },
    });

    await runCli(["add", "a body", "--json"], harness.runtime);

    expect(harness.openedPaths).toEqual(["/custom/data/papercuts.sqlite3"]);
  });

  test("a relative PAPERCUTS_HOME is invalid input before any store open", async () => {
    const harness = createHarness({
      repoContext: null,
      environment: { papercutsHome: "relative/path" },
    });

    const exitCode = await runCli(["add", "a body", "--json"], harness.runtime);

    expect(exitCode).toBe(2);
    expect(harness.openCalls).toBe(0);
  });

  test("an unknown command is a JSON usage error on stdout with empty stderr", async () => {
    const harness = createHarness();

    const exitCode = await runCli(["bogus", "--json"], harness.runtime);
    const envelope = parseEnvelope(harness.stdoutText());

    expect(exitCode).toBe(2);
    expect(envelope["ok"]).toBe(false);
    expect((envelope["error"] as Record<string, unknown>)["code"]).toBe(
      "invalid_input",
    );
    expect(harness.stderrText()).toBe("");
    expect(harness.openCalls).toBe(0);
  });

  test("an unknown command is a fixed human error on stderr", async () => {
    const harness = createHarness();

    const exitCode = await runCli(["bogus"], harness.runtime);

    expect(exitCode).toBe(2);
    expect(harness.stdoutText()).toBe("");
    expect(harness.stderrText()).toBe("Invalid input.\n");
  });
});
