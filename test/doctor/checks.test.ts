import { describe, expect, test } from "bun:test";

import { PapercutsError } from "../../src/domain/errors";
import type {
  PapercutStore,
  RepoContext,
  ResolvedRepoContext,
  ScreenedText,
  StoreHealth,
} from "../../src/domain/types";
import { resolvePapercutsPaths } from "../../src/platform/paths";
import type { SetupPlan, SetupRequest } from "../../src/setup/types";
import { CURRENT_SCHEMA_VERSION } from "../../src/storage/sqlite-store";
import {
  runDoctor,
  type DoctorContext,
  type DoctorEnvironment,
  type DoctorPathInfo,
  type DoctorReport,
} from "../../src/doctor/checks";

function screened(value: string): ScreenedText {
  return value as unknown as ScreenedText;
}

function directoryInfo(mode: number, uid: number): DoctorPathInfo {
  return { mode, uid, isFile: false, isDirectory: true };
}

function fileInfo(mode: number, uid: number): DoctorPathInfo {
  return { mode, uid, isFile: true, isDirectory: false };
}

function goodHealth(): StoreHealth {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    integrity: "ok",
    sqliteVersion: "3.45.0",
    lockAvailable: true,
  };
}

interface StoreProbe {
  store: PapercutStore;
  opens: number;
  closes: number;
  listed: boolean;
}

function fakeStoreFactory(
  health: StoreHealth | (() => StoreHealth),
): { openStore: (path: string) => PapercutStore; probe: StoreProbe } {
  const probe: StoreProbe = {
    opens: 0,
    closes: 0,
    listed: false,
    store: undefined as unknown as PapercutStore,
  };
  const store: PapercutStore = {
    append() {
      throw new Error("doctor must not append records");
    },
    list() {
      probe.listed = true;
      throw new Error("doctor must not read record bodies");
    },
    health() {
      return typeof health === "function" ? health() : health;
    },
    close() {
      probe.closes += 1;
    },
  };
  probe.store = store;
  return {
    probe,
    openStore(_path: string): PapercutStore {
      probe.opens += 1;
      return store;
    },
  };
}

function makeEnvironment(
  overrides: Partial<DoctorEnvironment> = {},
): DoctorEnvironment {
  return {
    cwd: "/work/project",
    home: "/home/user",
    papercutsHome: "/data/papercuts",
    codexHome: "/home/user/.codex",
    pathValue: "/usr/local/bin:/usr/bin",
    ...overrides,
  };
}

interface ContextOverrides {
  environment?: DoctorEnvironment;
  clientVersion?: string;
  runtimeVersion?: string;
  currentUid?: number;
  stats?: Map<string, DoctorPathInfo | null>;
  openStore?: (path: string) => PapercutStore;
  resolveRepoContext?: (cwd: string) => Promise<ResolvedRepoContext | null>;
  planSetup?: (request: SetupRequest) => Promise<SetupPlan>;
}

function makeContext(overrides: ContextOverrides = {}): DoctorContext {
  const environment = overrides.environment ?? makeEnvironment();
  const stats = overrides.stats ?? new Map<string, DoctorPathInfo | null>();
  const openStore =
    overrides.openStore ?? fakeStoreFactory(goodHealth()).openStore;

  return {
    clientVersion: overrides.clientVersion ?? "0.1.0",
    runtimeVersion: overrides.runtimeVersion ?? "1.3.0",
    currentUid: overrides.currentUid ?? 501,
    environment,
    async statPath(path: string): Promise<DoctorPathInfo | null> {
      return stats.has(path) ? (stats.get(path) ?? null) : null;
    },
    openStore,
    resolveRepoContext:
      overrides.resolveRepoContext ?? (async () => null),
    planSetup:
      overrides.planSetup ??
      (async (request): Promise<SetupPlan> => ({
        harness: request.harness,
        action: request.action,
        scope: request.scope,
        canonicalScopeRoot: "/canonical",
        state: "current",
        mutations: [],
      })),
  };
}

function messagesOf(report: DoctorReport): string {
  return report.checks.map((check) => check.message).join("\n");
}

function checkByName(
  report: DoctorReport,
  name: string,
): { name: string; status: string; message: string } {
  const found = report.checks.find((check) => check.name === name);
  if (found === undefined) {
    throw new Error(`missing doctor check: ${name}`);
  }
  return found;
}

describe("runDoctor", () => {
  test("returns the fixed { ok, checks } structure with typed statuses", async () => {
    const environment = makeEnvironment();
    const { dataDir, databasePath } = resolvePapercutsPaths(environment);
    const stats = new Map<string, DoctorPathInfo | null>([
      [dataDir, directoryInfo(0o700, 501)],
      [databasePath, fileInfo(0o600, 501)],
      ["/usr/local/bin/papercuts", fileInfo(0o755, 501)],
    ]);
    const factory = fakeStoreFactory(goodHealth());
    const repoContext: RepoContext = {
      key: "0".repeat(64),
      keyKind: "remote",
      displayName: screened("owner/repo"),
      root: screened("/work/project"),
      cwdRelative: screened("."),
      branch: screened("main"),
      head: screened("0".repeat(40)),
    };

    const report = await runDoctor(
      makeContext({
        environment,
        stats,
        openStore: factory.openStore,
        resolveRepoContext: async () => ({
          context: repoContext,
          redactionCount: 0,
        }),
      }),
    );

    expect(report.ok).toBe(true);
    expect(Array.isArray(report.checks)).toBe(true);
    for (const check of report.checks) {
      expect(typeof check.name).toBe("string");
      expect(check.name.length).toBeGreaterThan(0);
      expect(["ok", "warn", "error"]).toContain(check.status);
      expect(typeof check.message).toBe("string");
      expect(check.message.length).toBeGreaterThan(0);
    }
    for (const name of [
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
    ]) {
      expect(checkByName(report, name).status).toBe("ok");
    }
    expect(factory.probe.opens).toBe(1);
    expect(factory.probe.closes).toBe(1);
    expect(factory.probe.listed).toBe(false);
  });

  test("reports safe version facts in messages", async () => {
    const environment = makeEnvironment();
    const { dataDir, databasePath } = resolvePapercutsPaths(environment);
    const stats = new Map<string, DoctorPathInfo | null>([
      [dataDir, directoryInfo(0o700, 501)],
      [databasePath, fileInfo(0o600, 501)],
    ]);

    const report = await runDoctor(
      makeContext({
        environment,
        clientVersion: "0.1.0",
        runtimeVersion: "1.3.7",
        stats,
        openStore: fakeStoreFactory({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          integrity: "ok",
          sqliteVersion: "3.46.1",
          lockAvailable: true,
        }).openStore,
      }),
    );

    expect(checkByName(report, "cli-version").message).toContain("0.1.0");
    expect(checkByName(report, "runtime-version").message).toContain("1.3.7");
    expect(checkByName(report, "sqlite-version").message).toContain("3.46.1");
  });

  test("never leaks bodies, remotes, environment values, or instruction content", async () => {
    const environment = makeEnvironment({
      cwd: "/ENV_CWD_CANARY/project",
      home: "/ENV_HOME_CANARY/home",
      papercutsHome: "/ENV_PHOME_CANARY/data",
      codexHome: "/ENV_CODEX_CANARY/.codex",
      pathValue: "/usr/bin:/ENV_PATH_CANARY/bin",
    });
    const { dataDir, databasePath } = resolvePapercutsPaths(environment);
    const stats = new Map<string, DoctorPathInfo | null>([
      [dataDir, directoryInfo(0o700, 501)],
      [databasePath, fileInfo(0o600, 501)],
    ]);
    const repoContext: RepoContext = {
      key: "a".repeat(64),
      keyKind: "remote",
      displayName: screened("REMOTE_CANARY/repo"),
      root: screened("/REMOTE_CANARY/root"),
      cwdRelative: screened("REMOTE_CANARY/sub"),
      branch: screened("REMOTE_CANARY_branch"),
      head: screened("REMOTE_CANARY_head"),
    };
    const canaryPlan = async (request: SetupRequest): Promise<SetupPlan> => ({
      harness: request.harness,
      action: request.action,
      scope: request.scope,
      canonicalScopeRoot: "/ENV_CODEX_CANARY/.codex",
      state: "conflict",
      mutations: [
        {
          path: "/CODEX_TARGET_CANARY/AGENTS.md",
          expectedSha256: null,
          nextContent: "INSTRUCTION_CANARY body",
          createMode: 0o600,
          managedDiff: ["INSTRUCTION_CANARY diff line"],
        },
      ],
      snippet: "INSTRUCTION_CANARY snippet",
    });

    const report = await runDoctor(
      makeContext({
        environment,
        stats,
        openStore: fakeStoreFactory(goodHealth()).openStore,
        resolveRepoContext: async () => ({
          context: repoContext,
          redactionCount: 3,
        }),
        planSetup: canaryPlan,
      }),
    );

    const serialized = JSON.stringify(report);
    for (const canary of [
      "BODY_CANARY",
      "REMOTE_CANARY",
      "INSTRUCTION_CANARY",
      "CODEX_TARGET_CANARY",
      "ENV_CWD_CANARY",
      "ENV_HOME_CANARY",
      "ENV_PHOME_CANARY",
      "ENV_CODEX_CANARY",
      "ENV_PATH_CANARY",
    ]) {
      expect(serialized).not.toContain(canary);
      expect(messagesOf(report)).not.toContain(canary);
    }
  });

  test("degrades missing resources to warnings without throwing", async () => {
    const environment: DoctorEnvironment = {
      cwd: "/work/project",
      home: "/home/user",
      papercutsHome: "/data/papercuts",
      codexHome: "/home/user/.codex",
    };
    const factory = fakeStoreFactory(goodHealth());

    const report = await runDoctor(
      makeContext({
        environment,
        stats: new Map(),
        openStore: factory.openStore,
        resolveRepoContext: async () => null,
        planSetup: async () => {
          throw new PapercutsError("setup_conflict");
        },
      }),
    );

    expect(report.ok).toBe(true);
    expect(checkByName(report, "path").status).toBe("warn");
    expect(checkByName(report, "data-directory").status).toBe("warn");
    expect(checkByName(report, "database-file").status).toBe("warn");
    expect(checkByName(report, "sqlite-version").status).toBe("warn");
    expect(checkByName(report, "schema-version").status).toBe("warn");
    expect(checkByName(report, "integrity").status).toBe("warn");
    expect(checkByName(report, "write-lock").status).toBe("warn");
    expect(checkByName(report, "git-attribution").status).toBe("ok");
    expect(checkByName(report, "setup-codex-user").status).toBe("warn");
    expect(checkByName(report, "setup-claude-user").status).toBe("warn");
    expect(factory.probe.opens).toBe(0);
  });

  test("flags permission and ownership problems as errors", async () => {
    const environment = makeEnvironment();
    const { dataDir, databasePath } = resolvePapercutsPaths(environment);
    const stats = new Map<string, DoctorPathInfo | null>([
      [dataDir, directoryInfo(0o755, 501)],
      [databasePath, fileInfo(0o644, 999)],
    ]);

    const report = await runDoctor(
      makeContext({
        environment,
        stats,
        currentUid: 501,
      }),
    );

    expect(checkByName(report, "data-directory").status).toBe("error");
    expect(checkByName(report, "database-file").status).toBe("error");
    expect(report.ok).toBe(false);
  });

  test("flags a foreign-owned data directory even with owner-only mode", async () => {
    const environment = makeEnvironment();
    const { dataDir, databasePath } = resolvePapercutsPaths(environment);
    const stats = new Map<string, DoctorPathInfo | null>([
      [dataDir, directoryInfo(0o700, 999)],
      [databasePath, fileInfo(0o600, 501)],
    ]);

    const report = await runDoctor(
      makeContext({
        environment,
        stats,
        currentUid: 501,
      }),
    );

    const check = checkByName(report, "data-directory");
    expect(check.status).toBe("error");
    expect(check.message).toContain("999");
    expect(check.message).toContain("501");
    expect(report.ok).toBe(false);
  });

  test("flags a foreign-owned database even with owner-only mode", async () => {
    const environment = makeEnvironment();
    const { dataDir, databasePath } = resolvePapercutsPaths(environment);
    const stats = new Map<string, DoctorPathInfo | null>([
      [dataDir, directoryInfo(0o700, 501)],
      [databasePath, fileInfo(0o600, 999)],
    ]);

    const report = await runDoctor(
      makeContext({
        environment,
        stats,
        currentUid: 501,
      }),
    );

    const check = checkByName(report, "database-file");
    expect(check.status).toBe("error");
    expect(check.message).toContain("999");
    expect(check.message).toContain("501");
    expect(report.ok).toBe(false);
  });

  test("flags integrity failure and a future schema as errors", async () => {
    const environment = makeEnvironment();
    const { dataDir, databasePath } = resolvePapercutsPaths(environment);
    const stats = new Map<string, DoctorPathInfo | null>([
      [dataDir, directoryInfo(0o700, 501)],
      [databasePath, fileInfo(0o600, 501)],
    ]);

    const report = await runDoctor(
      makeContext({
        environment,
        stats,
        openStore: fakeStoreFactory({
          schemaVersion: CURRENT_SCHEMA_VERSION + 1,
          integrity: "malformed database page 4",
          sqliteVersion: "3.45.0",
          lockAvailable: false,
        }).openStore,
      }),
    );

    expect(checkByName(report, "integrity").status).toBe("error");
    expect(checkByName(report, "schema-version").status).toBe("error");
    expect(checkByName(report, "write-lock").status).toBe("warn");
    expect(checkByName(report, "sqlite-version").status).toBe("ok");
    expect(report.ok).toBe(false);
    expect(messagesOf(report)).not.toContain("malformed database page 4");
  });

  test("degrades a busy store to warnings without throwing", async () => {
    const environment = makeEnvironment();
    const { dataDir, databasePath } = resolvePapercutsPaths(environment);
    const stats = new Map<string, DoctorPathInfo | null>([
      [dataDir, directoryInfo(0o700, 501)],
      [databasePath, fileInfo(0o600, 501)],
    ]);

    const report = await runDoctor(
      makeContext({
        environment,
        stats,
        openStore(): PapercutStore {
          throw new PapercutsError("store_busy");
        },
      }),
    );

    expect(report.ok).toBe(true);
    expect(checkByName(report, "sqlite-version").status).toBe("warn");
    expect(checkByName(report, "schema-version").status).toBe("warn");
    expect(checkByName(report, "integrity").status).toBe("warn");
    expect(checkByName(report, "write-lock").status).toBe("warn");
  });

  test("detects the papercuts executable on PATH via statPath", async () => {
    const environment = makeEnvironment({
      pathValue: "/opt/tools:/usr/local/bin:/usr/bin",
    });
    const { dataDir, databasePath } = resolvePapercutsPaths(environment);
    const stats = new Map<string, DoctorPathInfo | null>([
      [dataDir, directoryInfo(0o700, 501)],
      [databasePath, fileInfo(0o600, 501)],
      ["/usr/local/bin/papercuts", fileInfo(0o755, 501)],
    ]);

    const found = await runDoctor(makeContext({ environment, stats }));
    expect(checkByName(found, "path").status).toBe("ok");

    const missingStats = new Map<string, DoctorPathInfo | null>([
      [dataDir, directoryInfo(0o700, 501)],
      [databasePath, fileInfo(0o600, 501)],
      ["/usr/local/bin/papercuts", fileInfo(0o644, 501)],
    ]);
    const notFound = await runDoctor(
      makeContext({ environment, stats: missingStats }),
    );
    expect(checkByName(notFound, "path").status).toBe("warn");
  });

  test("reports setup outdated and conflict states as warnings", async () => {
    const environment = makeEnvironment();
    const { dataDir, databasePath } = resolvePapercutsPaths(environment);
    const stats = new Map<string, DoctorPathInfo | null>([
      [dataDir, directoryInfo(0o700, 501)],
      [databasePath, fileInfo(0o600, 501)],
    ]);

    const report = await runDoctor(
      makeContext({
        environment,
        stats,
        planSetup: async (request): Promise<SetupPlan> => ({
          harness: request.harness,
          action: request.action,
          scope: request.scope,
          canonicalScopeRoot: "/canonical",
          state: request.harness === "codex" ? "outdated" : "conflict",
          mutations: [],
        }),
      }),
    );

    expect(checkByName(report, "setup-codex-user").status).toBe("warn");
    expect(checkByName(report, "setup-claude-user").status).toBe("warn");
    expect(report.ok).toBe(true);
  });
});
