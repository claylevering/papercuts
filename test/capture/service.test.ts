import { describe, expect, test } from "bun:test";

import { PapercutsError } from "../../src/domain/errors";
import type {
  CaptureSource,
  Papercut,
  PapercutQuery,
  PapercutStore,
  ResolvedRepoContext,
  StoreHealth,
} from "../../src/domain/types";
import { redact } from "../../src/security/redactor";
import {
  createCaptureService,
  type CaptureInput,
  type CaptureServiceDependencies,
} from "../../src/capture/service";

const FIXED_ID = "123e4567-e89b-42d3-a456-426614174000";
const FIXED_NOW = 1_752_179_200_000;

describe("createCaptureService", () => {
  test.each(["", "body\0with-nul"])(
    "rejects a missing or invalid body before repository lookup",
    async (body) => {
      const harness = createHarness();

      await expect(
        harness.service.capture(input({ body })),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(harness.resolveCalls).toBe(0);
      expect(harness.store.records).toHaveLength(0);
    },
  );

  test("accepts a body at the 65,536-byte UTF-8 boundary", async () => {
    const harness = createHarness();
    const body = "é".repeat(32_768);

    await harness.service.capture(input({ body }));

    expect(new TextEncoder().encode(String(harness.store.records[0]?.body))).toHaveLength(
      65_536,
    );
    expect(harness.store.records).toHaveLength(1);
  });

  test("rejects a body at 65,537 UTF-8 bytes before redaction or repository lookup", async () => {
    const harness = createHarness();
    const rawCredential = "ghp_" + "O".repeat(24);
    const body = "a".repeat(65_537 - rawCredential.length) + rawCredential;

    expect(new TextEncoder().encode(body)).toHaveLength(65_537);

    try {
      await harness.service.capture(input({ body }));
      throw new Error("expected capture to reject oversized input");
    } catch (error) {
      expect(error).toBeInstanceOf(PapercutsError);
      expect((error as PapercutsError).code).toBe("invalid_input");
      expect(JSON.stringify(error)).not.toContain(rawCredential);
    }
    expect(harness.resolveCalls).toBe(0);
    expect(harness.store.records).toHaveLength(0);
  });

  test("rejects a screened body that expands beyond the persistence bound", async () => {
    const harness = createHarness();
    const body = "Cookie:x\n".repeat(7_000);

    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
      65_536,
    );
    await expect(
      harness.service.capture(input({ body })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(harness.resolveCalls).toBe(0);
    expect(harness.store.records).toHaveLength(0);
  });

  test("rejects unsupported capture sources at runtime", async () => {
    const harness = createHarness();

    await expect(
      harness.service.capture(
        input({ source: "unsupported" as CaptureSource }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(harness.resolveCalls).toBe(0);
    expect(harness.store.records).toHaveLength(0);
  });

  test("accepts metadata at every bound, including sixteen tags", async () => {
    const harness = createHarness();
    const tags = Array.from({ length: 16 }, (_, index) =>
      `${String(index).padStart(2, "0")}${"t".repeat(62)}`,
    );

    await harness.service.capture(
      input({
        model: "m".repeat(256),
        category: "c".repeat(64),
        tags,
      }),
    );

    expect(harness.store.records[0]?.model).toHaveLength(256);
    expect(harness.store.records[0]?.category).toHaveLength(64);
    expect(harness.store.records[0]?.tags).toHaveLength(16);
  });

  test.each([
    ["model", { model: "m".repeat(257) }],
    ["category", { category: "c".repeat(65) }],
    ["tag", { tags: ["t".repeat(65)] }],
    [
      "tag count",
      { tags: Array.from({ length: 17 }, (_, index) => `tag-${index}`) },
    ],
    ["empty model", { model: "" }],
    ["empty category", { category: "" }],
    ["empty normalized tag", { tags: ["   "] }],
    ["NUL metadata", { tags: ["tag\0value"] }],
  ] as const)("rejects invalid %s metadata before repository lookup", async (_, overrides) => {
    const harness = createHarness();

    await expect(
      harness.service.capture(input(overrides)),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(harness.resolveCalls).toBe(0);
    expect(harness.store.records).toHaveLength(0);
  });

  test("normalizes, deduplicates, and deterministically sorts screened tags", async () => {
    const harness = createHarness();

    await harness.service.capture(
      input({ tags: [" Zeta ", "alpha", "BETA", " ALPHA ", "beta"] }),
    );

    expect(harness.store.records[0]?.tags.map(String)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  test("redacts every observation string and adds repository replacement accounting", async () => {
    const bodyCredential = "A".repeat(32);
    const modelCredential = "ghp_" + "M".repeat(24);
    const categoryCredential = "C".repeat(32);
    const tagCredential = "T".repeat(32);
    const repoRootCredential = "ghp_" + "R".repeat(24);
    const repoCwdCredential = "API_TOKEN=" + "W".repeat(32);
    const repository = resolvedRepository({
      root: `/tmp/${repoRootCredential}`,
      cwdRelative: repoCwdCredential,
      redactionCount: 2,
    });
    const harness = createHarness({ repository });

    const result = await harness.service.capture(
      input({
        body: `Authorization: Bearer ${bodyCredential}`,
        model: modelCredential,
        category: `API_TOKEN=${categoryCredential}`,
        tags: [`Cookie: session=${tagCredential}`, " Beta ", "beta"],
        source: "codex",
      }),
    );
    const record = harness.store.records[0];
    expect(record).toBeDefined();
    if (record === undefined) {
      throw new Error("expected captured record");
    }

    expect(String(record.body)).toBe("[REDACTED:AUTHORIZATION]");
    expect(String(record.model)).toBe("[REDACTED:CREDENTIAL]");
    expect(String(record.category)).toBe("[REDACTED:SECRET]");
    expect(record.tags.map(String)).toEqual(["[redacted:cookie]", "beta"]);
    expect(record.repo).toEqual(repository.context);
    expect(record.redactionCount).toBe(6);
    expect(record.redactionVersion).toBe("1");
    expect(result.receipt.redactionCount).toBe(6);

    const persisted = JSON.stringify(record);
    for (const raw of [
      bodyCredential,
      modelCredential,
      categoryCredential,
      tagCredential,
      repoRootCredential,
      repoCwdCredential,
    ]) {
      expect(persisted).not.toContain(raw);
    }
  });

  test("uses injected identity, time, client version, and repository context and appends once", async () => {
    const repository = resolvedRepository();
    const harness = createHarness({ repository });

    const result = await harness.service.capture(
      input({ source: "generic", model: "safe-model", category: "tooling" }),
    );

    expect(harness.store.appendCalls).toBe(1);
    expect(harness.store.records).toHaveLength(1);
    expect(harness.store.records[0]).toMatchObject({
      id: FIXED_ID,
      createdAtMs: FIXED_NOW,
      source: "generic",
      model: "safe-model",
      category: "tooling",
      clientVersion: "0.1.0-test",
      repo: repository.context,
    });
    expect(result.receipt).toEqual({
      id: FIXED_ID,
      createdAtMs: FIXED_NOW,
      source: "generic",
      repository: { name: repository.context.displayName },
      redactionCount: repository.redactionCount,
    });
    expect(result.warnings).toEqual([]);
  });

  test.each([
    "not-a-uuid",
    "123e4567-e89b-12d3-a456-426614174000",
    "123e4567-e89b-42d3-c456-426614174000",
    `{${FIXED_ID}}`,
    "ghp_" + "I".repeat(24),
  ])("rejects an invalid generated UUID without appending", async (generatedId) => {
    const harness = createHarness({ randomUUID: () => generatedId });

    try {
      await harness.service.capture(input());
      throw new Error("expected generated UUID rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PapercutsError);
      expect((error as PapercutsError).code).toBe("safety_failure");
      expect(String(error)).not.toContain(generatedId);
      expect(JSON.stringify(error)).not.toContain(generatedId);
    }
    expect(harness.store.appendCalls).toBe(0);
    expect(harness.store.records).toHaveLength(0);
  });

  test("accepts uppercase UUIDv4 syntax and persists its canonical lowercase form", async () => {
    const harness = createHarness({
      randomUUID: () => FIXED_ID.toUpperCase(),
    });

    const result = await harness.service.capture(input());

    expect(harness.store.records[0]?.id).toBe(FIXED_ID);
    expect(result.receipt.id).toBe(FIXED_ID);
  });

  test("sanitizes a generated UUID provider failure without appending", async () => {
    const rawCredential = "ghp_" + "U".repeat(24);
    const harness = createHarness({
      randomUUID() {
        throw new Error(`UUID provider failed: ${rawCredential}`);
      },
    });

    try {
      await harness.service.capture(input());
      throw new Error("expected UUID provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PapercutsError);
      expect((error as PapercutsError).code).toBe("internal_error");
      expect(String(error)).not.toContain(rawCredential);
      expect(JSON.stringify(error)).not.toContain(rawCredential);
    }
    expect(harness.store.appendCalls).toBe(0);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    8_640_000_000_000_001,
  ])(
    "rejects an invalid generated timestamp without appending",
    async (timestamp) => {
      const harness = createHarness({ now: () => timestamp });

      await expect(harness.service.capture(input())).rejects.toMatchObject({
        code: "internal_error",
      });
      expect(harness.store.appendCalls).toBe(0);
      expect(harness.store.records).toHaveLength(0);
    },
  );

  test("sanitizes a generated timestamp provider failure without appending", async () => {
    const rawCredential = "ghp_" + "N".repeat(24);
    const harness = createHarness({
      now() {
        throw new Error(`clock failed: ${rawCredential}`);
      },
    });

    try {
      await harness.service.capture(input());
      throw new Error("expected timestamp provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PapercutsError);
      expect((error as PapercutsError).code).toBe("internal_error");
      expect(String(error)).not.toContain(rawCredential);
      expect(JSON.stringify(error)).not.toContain(rawCredential);
    }
    expect(harness.store.appendCalls).toBe(0);
  });

  test.each(["", "version-one", "1.2", "1.2.3.4", "v1.2.3"])(
    "rejects an invalid client version without appending",
    async (clientVersion) => {
      const harness = createHarness({ clientVersion });

      await expect(harness.service.capture(input())).rejects.toMatchObject({
        code: "internal_error",
      });
      expect(harness.store.appendCalls).toBe(0);
    },
  );

  test("rejects a secret-like semantic client version without exposing it", async () => {
    const credential = "sk-" + "V".repeat(24);
    const clientVersion = `0.1.0-${credential}`;
    const harness = createHarness({ clientVersion });

    try {
      await harness.service.capture(input());
      throw new Error("expected client version rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PapercutsError);
      expect((error as PapercutsError).code).toBe("safety_failure");
      expect(String(error)).not.toContain(credential);
      expect(JSON.stringify(error)).not.toContain(credential);
    }
    expect(harness.store.appendCalls).toBe(0);
  });

  test("accepts a bounded semantic client version", async () => {
    const clientVersion = "1.2.3-alpha.1+build.5";
    const harness = createHarness({ clientVersion });

    await harness.service.capture(input());

    expect(harness.store.records[0]?.clientVersion).toBe(clientVersion);
  });

  test("captures an unscoped record when no repository exists", async () => {
    const harness = createHarness({ repository: null });

    const result = await harness.service.capture(input());

    expect(harness.store.records[0]?.repo).toBeNull();
    expect(result.receipt.repository).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  test("downgrades an unexpected repository failure to one fixed warning", async () => {
    const rawCredential = "ghp_" + "F".repeat(24);
    const harness = createHarness({
      repositoryError: new Error(`repository failure ${rawCredential}`),
    });

    const result = await harness.service.capture(input());

    expect(harness.store.records).toHaveLength(1);
    expect(harness.store.records[0]?.repo).toBeNull();
    expect(result.receipt.repository).toBeNull();
    expect(result.warnings).toEqual([
      "Repository context was unavailable; captured without repository attribution.",
    ]);
    expect(JSON.stringify(result)).not.toContain(rawCredential);
  });

  test("keeps a repository safety failure fatal and does not append", async () => {
    const harness = createHarness({
      repositoryError: new PapercutsError("safety_failure"),
    });

    await expect(harness.service.capture(input())).rejects.toMatchObject({
      code: "safety_failure",
    });
    expect(harness.store.records).toHaveLength(0);
    expect(harness.store.appendCalls).toBe(0);
  });

  test("returns a body-free receipt with no private repository or metadata fields", async () => {
    const body = "private observation body";
    const model = "private model";
    const category = "private category";
    const tag = "private tag";
    const repository = resolvedRepository();
    const harness = createHarness({ repository });

    const { receipt } = await harness.service.capture(
      input({ body, model, category, tags: [tag] }),
    );

    expect(Object.keys(receipt).sort()).toEqual([
      "createdAtMs",
      "id",
      "redactionCount",
      "repository",
      "source",
    ]);
    expect(Object.keys(receipt.repository ?? {})).toEqual(["name"]);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(body);
    expect(serialized).not.toContain(model);
    expect(serialized).not.toContain(category);
    expect(serialized).not.toContain(tag);
    expect(serialized).not.toContain(repository.context.root);
    expect(serialized).not.toContain(repository.context.key);
    expect(serialized).not.toContain(repository.context.cwdRelative);
  });
});

function input(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    body: "A small papercut.",
    source: "manual",
    cwd: "/tmp/project",
    ...overrides,
  };
}

function resolvedRepository(overrides: {
  root?: string;
  cwdRelative?: string;
  redactionCount?: number;
} = {}): ResolvedRepoContext {
  return {
    context: {
      key: "a".repeat(64),
      keyKind: "remote",
      displayName: redact("safe-repository").text,
      root: redact(overrides.root ?? "/tmp/safe-repository").text,
      cwdRelative: redact(overrides.cwdRelative ?? "src").text,
      branch: redact("main").text,
      head: redact("b".repeat(40)).text,
    },
    redactionCount: overrides.redactionCount ?? 0,
  };
}

function createHarness(options: {
  repository?: ResolvedRepoContext | null;
  repositoryError?: Error;
  randomUUID?: () => string;
  now?: () => number;
  clientVersion?: string;
} = {}): {
  service: ReturnType<typeof createCaptureService>;
  store: FakeStore;
  readonly resolveCalls: number;
} {
  const store = new FakeStore();
  let resolveCalls = 0;
  const dependencies: CaptureServiceDependencies = {
    store,
    async resolveRepoContext() {
      resolveCalls += 1;
      if (options.repositoryError !== undefined) {
        throw options.repositoryError;
      }
      return options.repository === undefined ? null : options.repository;
    },
    now: options.now ?? (() => FIXED_NOW),
    randomUUID: options.randomUUID ?? (() => FIXED_ID),
    clientVersion: options.clientVersion ?? "0.1.0-test",
  };

  return {
    service: createCaptureService(dependencies),
    store,
    get resolveCalls() {
      return resolveCalls;
    },
  };
}

class FakeStore implements PapercutStore {
  readonly records: Papercut[] = [];
  appendCalls = 0;

  append(record: Papercut): void {
    this.appendCalls += 1;
    this.records.push(record);
  }

  list(_query: PapercutQuery): readonly Papercut[] {
    return this.records;
  }

  setResolved(_id: string, _resolvedAtMs: number | null): boolean {
    return false;
  }

  health(): StoreHealth {
    return {
      schemaVersion: 1,
      integrity: "ok",
      sqliteVersion: "test",
      lockAvailable: true,
    };
  }

  close(): void {}
}
