import { describe, expect, test } from "bun:test";

import type {
  Papercut,
  RepoContext,
  ScreenedText,
} from "../../src/domain/types";
import { summarize } from "../../src/views/stats";

describe("summarize", () => {
  test("returns the complete empty structural summary", () => {
    expect(summarize([])).toEqual({
      total: 0,
      firstAt: null,
      lastAt: null,
      byDay: {},
      bySource: {},
      byRepository: {},
      byCategory: {},
      redactedRecordCount: 0,
      replacementCount: 0,
      exactRepeats: [],
    });
  });

  test("uses UTC buckets and deterministic lexical count keys", () => {
    const records = [
      makePapercut({
        id: "00000000-0000-4000-8000-000000000003",
        createdAtMs: Date.parse("2026-07-11T12:00:00.125Z"),
        source: "codex",
        body: screened("unique observation"),
        category: null,
        repo: makeRepo({ displayName: screened("zeta") }),
        redactionCount: 1,
      }),
      makePapercut({
        id: "00000000-0000-4000-8000-000000000001",
        createdAtMs: Date.parse("2026-07-10T23:59:59.500Z"),
        source: "codex",
        body: screened("same [REDACTED:SECRET] observation"),
        category: screened("tooling"),
        repo: makeRepo({ displayName: screened("zeta") }),
        redactionCount: 2,
      }),
      makePapercut({
        id: "00000000-0000-4000-8000-000000000004",
        createdAtMs: Date.parse("2026-07-11T18:30:00.000Z"),
        source: "generic",
        body: screened("outside a repository"),
        category: screened("build"),
        repo: null,
      }),
      makePapercut({
        id: "00000000-0000-4000-8000-000000000002",
        createdAtMs: Date.parse("2026-07-11T00:00:00.000Z"),
        source: "manual",
        body: screened("same [REDACTED:SECRET] observation"),
        category: screened("build"),
        repo: makeRepo({ displayName: screened("alpha") }),
      }),
    ];

    const summary = summarize(records);

    expect(summary).toEqual({
      total: 4,
      firstAt: "2026-07-10T23:59:59.500Z",
      lastAt: "2026-07-11T18:30:00.000Z",
      byDay: { "2026-07-10": 1, "2026-07-11": 3 },
      bySource: { codex: 2, generic: 1, manual: 1 },
      byRepository: { alpha: 1, zeta: 2 },
      byCategory: { build: 2, tooling: 1 },
      redactedRecordCount: 2,
      replacementCount: 3,
      exactRepeats: [
        { body: "same [REDACTED:SECRET] observation", count: 2 },
      ],
    });
    expect(Object.keys(summary.byDay)).toEqual(["2026-07-10", "2026-07-11"]);
    expect(Object.keys(summary.bySource)).toEqual([
      "codex",
      "generic",
      "manual",
    ]);
    expect(Object.keys(summary.byRepository)).toEqual(["alpha", "zeta"]);
    expect(Object.keys(summary.byCategory)).toEqual(["build", "tooling"]);
  });

  test("counts only exact repeated redacted bodies in lexical order", () => {
    const records = [
      makePapercut({ body: screened("zeta repeat\nsecond line") }),
      makePapercut({ body: screened("alpha repeat") }),
      makePapercut({ body: screened("zeta repeat\nsecond line") }),
      makePapercut({ body: screened("alpha repeat") }),
      makePapercut({ body: screened("alpha repeat") }),
      makePapercut({ body: screened("Alpha repeat") }),
      makePapercut({ body: screened("zeta repeat\nsecond line ") }),
    ];

    expect(summarize(records).exactRepeats).toEqual([
      { body: "alpha repeat", count: 3 },
      { body: "zeta repeat\nsecond line", count: 2 },
    ]);
  });
});

function screened(value: string): ScreenedText {
  return value as ScreenedText;
}

function makeRepo(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    key: "repository-fingerprint",
    keyKind: "local",
    displayName: screened("papercuts"),
    root: screened("/absolute/private/repository/root"),
    cwdRelative: screened("src/views"),
    branch: screened("task/views"),
    head: screened("a".repeat(40)),
    ...overrides,
  };
}

function makePapercut(overrides: Partial<Papercut> = {}): Papercut {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    createdAtMs: Date.parse("2026-07-10T12:00:00.000Z"),
    body: screened("default observation"),
    source: "manual",
    model: null,
    category: null,
    tags: [],
    clientVersion: "0.1.0",
    repo: makeRepo(),
    redactionCount: 0,
    redactionVersion: "1",
    ...overrides,
  };
}
