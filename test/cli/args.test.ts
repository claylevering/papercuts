import { describe, expect, test } from "bun:test";

import { PapercutsError } from "../../src/domain/errors";
import { parseArgs, type ParsedCommand } from "../../src/cli/args";

function parse(argv: readonly string[]): ParsedCommand {
  return parseArgs(argv);
}

/**
 * Assert that parsing `argv` throws the fixed usage error (`invalid_input`,
 * exit code 2) rather than succeeding or throwing any other class.
 */
function expectInvalid(argv: readonly string[]): void {
  let caught: unknown;

  try {
    parseArgs(argv);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(PapercutsError);
  const error = caught as PapercutsError;
  expect(error.code).toBe("invalid_input");
  expect(error.exitCode).toBe(2);
}

describe("parseArgs global flags", () => {
  test("no arguments resolves to general help", () => {
    expect(parse([])).toEqual({ kind: "help", json: false });
  });

  test("--help without a command is general help", () => {
    expect(parse(["--help"])).toEqual({ kind: "help", json: false });
  });

  test("-h is an alias for --help", () => {
    expect(parse(["-h"])).toEqual({ kind: "help", json: false });
  });

  test("--json without a command still resolves to help", () => {
    expect(parse(["--json"])).toEqual({ kind: "help", json: true });
  });

  test("--version resolves to version", () => {
    expect(parse(["--version"])).toEqual({ kind: "version", json: false });
  });

  test("--help wins over --version", () => {
    expect(parse(["--help", "--version"])).toEqual({
      kind: "help",
      json: false,
    });
  });

  test("--json applies to version", () => {
    expect(parse(["--json", "--version"])).toEqual({
      kind: "version",
      json: true,
    });
  });

  test("--help after a command sets the command topic", () => {
    expect(parse(["add", "--help"])).toEqual({
      kind: "help",
      topic: "add",
      json: false,
    });
  });

  test("--help before a command still sets the command topic", () => {
    expect(parse(["--help", "list"])).toEqual({
      kind: "help",
      topic: "list",
      json: false,
    });
  });

  test("--help short-circuits command validation", () => {
    // `--limit abc` would be a usage error, but help wins.
    expect(parse(["list", "--limit", "abc", "--help"])).toEqual({
      kind: "help",
      topic: "list",
      json: false,
    });
  });

  test("--version after a command wins over the command action", () => {
    expect(parse(["add", "--version"])).toEqual({
      kind: "version",
      json: false,
    });
  });

  test("--json is accepted before the command word", () => {
    expect(parse(["--json", "list"])).toEqual({
      kind: "list",
      repo: "auto",
      limit: 50,
      json: true,
    });
  });

  test("--json is accepted after the command word", () => {
    expect(parse(["list", "--json"])).toEqual({
      kind: "list",
      repo: "auto",
      limit: 50,
      json: true,
    });
  });

  test("--json is accepted interleaved with command options", () => {
    expect(parse(["list", "--json", "--limit", "5"])).toEqual({
      kind: "list",
      repo: "auto",
      limit: 5,
      json: true,
    });
  });

  test("an unknown command is a usage error", () => {
    expectInvalid(["bogus"]);
  });

  test("an unknown command with --help falls back to general help", () => {
    expect(parse(["bogus", "--help"])).toEqual({ kind: "help", json: false });
  });

  test("an unknown command with --version falls back to version", () => {
    expect(parse(["bogus", "--version"])).toEqual({
      kind: "version",
      json: false,
    });
  });

  test("a non-global flag before the command word is a usage error", () => {
    expectInvalid(["--limit", "5", "list"]);
  });
});

describe("parseArgs add", () => {
  test("positional text defaults to the manual source", () => {
    expect(parse(["add", "hello"])).toEqual({
      kind: "add",
      text: "hello",
      stdin: false,
      source: "manual",
      tags: [],
      json: false,
    });
  });

  test("--stdin captures without a positional body", () => {
    expect(parse(["add", "--stdin"])).toEqual({
      kind: "add",
      stdin: true,
      source: "manual",
      tags: [],
      json: false,
    });
  });

  test("positional text and --stdin together conflict", () => {
    expectInvalid(["add", "hello", "--stdin"]);
  });

  test("neither positional text nor --stdin is a usage error", () => {
    expectInvalid(["add"]);
  });

  test("multiple positional bodies are a usage error", () => {
    expectInvalid(["add", "one", "two"]);
  });

  test("empty positional text is a usage error", () => {
    expectInvalid(["add", ""]);
  });

  test("a NUL byte in positional text is a usage error", () => {
    expectInvalid(["add", "a\0b"]);
  });

  test("collects every optional metadata field", () => {
    expect(
      parse([
        "add",
        "--stdin",
        "--source",
        "claude-code",
        "--model",
        "gpt-mini",
        "--category",
        "stale-cache",
        "--tag",
        "cli",
        "--tag",
        "docs",
      ]),
    ).toEqual({
      kind: "add",
      stdin: true,
      source: "claude-code",
      model: "gpt-mini",
      category: "stale-cache",
      tags: ["cli", "docs"],
      json: false,
    });
  });

  test("accepts each capture source", () => {
    for (const source of ["manual", "codex", "claude-code", "generic"] as const) {
      expect(parse(["add", "--stdin", "--source", source])).toMatchObject({
        kind: "add",
        source,
      });
    }
  });

  test("rejects an unknown source", () => {
    expectInvalid(["add", "--stdin", "--source", "slack"]);
  });

  test("rejects an empty model value", () => {
    expectInvalid(["add", "--stdin", "--model", ""]);
  });

  test("rejects an over-length model value", () => {
    expectInvalid(["add", "--stdin", "--model", "m".repeat(257)]);
  });

  test("accepts a model at the byte boundary", () => {
    expect(
      parse(["add", "--stdin", "--model", "m".repeat(256)]),
    ).toMatchObject({ model: "m".repeat(256) });
  });

  test("rejects an over-length category value", () => {
    expectInvalid(["add", "--stdin", "--category", "c".repeat(65)]);
  });

  test("rejects an over-length tag value", () => {
    expectInvalid(["add", "--stdin", "--tag", "t".repeat(65)]);
  });

  test("rejects a whitespace-only tag", () => {
    expectInvalid(["add", "--stdin", "--tag", "   "]);
  });

  test("rejects more than sixteen tags", () => {
    const argv = ["add", "--stdin"];
    for (let index = 0; index < 17; index += 1) {
      argv.push("--tag", `t${index}`);
    }
    expectInvalid(argv);
  });

  test("accepts exactly sixteen tags", () => {
    const argv = ["add", "--stdin"];
    const expectedTags: string[] = [];
    for (let index = 0; index < 16; index += 1) {
      argv.push("--tag", `t${index}`);
      expectedTags.push(`t${index}`);
    }
    expect(parse(argv)).toMatchObject({ tags: expectedTags });
  });

  test("passes tags through without deduplication", () => {
    expect(parse(["add", "--stdin", "--tag", "dup", "--tag", "dup"])).toMatchObject(
      { tags: ["dup", "dup"] },
    );
  });

  test("rejects a duplicate single-value option", () => {
    expectInvalid(["add", "--stdin", "--source", "codex", "--source", "codex"]);
  });

  test("rejects an unknown flag", () => {
    expectInvalid(["add", "--stdin", "--bogus"]);
  });

  test("rejects a missing option value at the end of input", () => {
    expectInvalid(["add", "--stdin", "--model"]);
  });

  test("supports the inline --opt=value form", () => {
    expect(parse(["add", "--stdin", "--source=codex"])).toMatchObject({
      source: "codex",
    });
  });

  test("-- ends option parsing so dashed messages are positional", () => {
    expect(parse(["add", "--", "--not-a-flag"])).toEqual({
      kind: "add",
      text: "--not-a-flag",
      stdin: false,
      source: "manual",
      tags: [],
      json: false,
    });
  });
});

describe("parseArgs list", () => {
  test("defaults to auto repository scope and a limit of fifty", () => {
    expect(parse(["list"])).toEqual({
      kind: "list",
      repo: "auto",
      limit: 50,
      json: false,
    });
  });

  test("accepts explicit current and all scopes", () => {
    expect(parse(["list", "--repo", "current"])).toMatchObject({
      repo: "current",
    });
    expect(parse(["list", "--repo", "all"])).toMatchObject({ repo: "all" });
  });

  test("rejects an explicit auto scope", () => {
    expectInvalid(["list", "--repo", "auto"]);
  });

  test("rejects an unknown scope", () => {
    expectInvalid(["list", "--repo", "somewhere"]);
  });

  test("accepts the minimum and maximum limits", () => {
    expect(parse(["list", "--limit", "1"])).toMatchObject({ limit: 1 });
    expect(parse(["list", "--limit", "1000"])).toMatchObject({ limit: 1000 });
  });

  test.each(["0", "1001", "-5", "3.5", "abc", "1e3", ""])(
    "rejects an out-of-range or malformed limit %p",
    (value) => {
      expectInvalid(["list", "--limit", value]);
    },
  );

  test("supports the inline limit form", () => {
    expect(parse(["list", "--limit=5"])).toMatchObject({ limit: 5 });
  });

  test.each([
    ["30m", 1_800_000],
    ["45m", 2_700_000],
    ["2h", 7_200_000],
    ["1h", 3_600_000],
    ["7d", 604_800_000],
    ["1d", 86_400_000],
  ] as const)("parses the %s duration window", (value, expected) => {
    expect(parse(["list", "--since", value])).toMatchObject({
      sinceMs: expected,
    });
  });

  test.each(["0d", "5", "5w", "-3d", "1.5h", "m", ""])(
    "rejects a malformed duration %p",
    (value) => {
      expectInvalid(["list", "--since", value]);
    },
  );

  test("rejects a duplicate limit", () => {
    expectInvalid(["list", "--limit", "5", "--limit", "6"]);
  });

  test("rejects an unexpected positional", () => {
    expectInvalid(["list", "extra"]);
  });

  test("combines scope, window, and limit", () => {
    expect(parse(["list", "--repo", "current", "--since", "1d", "--limit", "10"])).toEqual({
      kind: "list",
      repo: "current",
      sinceMs: 86_400_000,
      limit: 10,
      json: false,
    });
  });
});

describe("parseArgs stats", () => {
  test("defaults to auto scope with no window", () => {
    expect(parse(["stats"])).toEqual({
      kind: "stats",
      repo: "auto",
      json: false,
    });
  });

  test("accepts scope and window", () => {
    expect(parse(["stats", "--repo", "all", "--since", "1h"])).toEqual({
      kind: "stats",
      repo: "all",
      sinceMs: 3_600_000,
      json: false,
    });
  });

  test("rejects a limit flag it does not support", () => {
    expectInvalid(["stats", "--limit", "5"]);
  });

  test("rejects an output flag it does not support", () => {
    expectInvalid(["stats", "--output", "x.md"]);
  });
});

describe("parseArgs export", () => {
  test("defaults to auto scope, no output, and force off", () => {
    expect(parse(["export"])).toEqual({
      kind: "export",
      repo: "auto",
      force: false,
      json: false,
    });
  });

  test("captures an output path", () => {
    expect(parse(["export", "--output", "cuts.md"])).toMatchObject({
      output: "cuts.md",
    });
  });

  test("--force is a boolean flag", () => {
    expect(parse(["export", "--force"])).toMatchObject({ force: true });
  });

  test("rejects an empty output path", () => {
    expectInvalid(["export", "--output", ""]);
  });

  test("rejects a missing output value", () => {
    expectInvalid(["export", "--output"]);
  });

  test("combines every export option", () => {
    expect(
      parse(["export", "--repo", "all", "--since", "2h", "--output", "out.md", "--force"]),
    ).toEqual({
      kind: "export",
      repo: "all",
      sinceMs: 7_200_000,
      output: "out.md",
      force: true,
      json: false,
    });
  });

  test("rejects a limit flag it does not support", () => {
    expectInvalid(["export", "--limit", "5"]);
  });
});

describe("parseArgs setup", () => {
  test("defaults to the user scope", () => {
    expect(parse(["setup", "codex"])).toEqual({
      kind: "setup",
      harness: "codex",
      scope: "user",
      undo: false,
      apply: false,
      json: false,
    });
  });

  test("accepts the repo scope and each harness", () => {
    expect(parse(["setup", "claude-code", "--scope", "repo"])).toEqual({
      kind: "setup",
      harness: "claude-code",
      scope: "repo",
      undo: false,
      apply: false,
      json: false,
    });
  });

  test("collects undo and apply flags", () => {
    expect(parse(["setup", "codex", "--undo", "--apply"])).toMatchObject({
      undo: true,
      apply: true,
    });
  });

  test("represents generic --apply rather than rejecting it", () => {
    // The parser does not reject this; run.ts is responsible for refusing a
    // generic apply. The parsed shape must faithfully preserve the request.
    expect(parse(["setup", "generic", "--apply"])).toEqual({
      kind: "setup",
      harness: "generic",
      scope: "user",
      undo: false,
      apply: true,
      json: false,
    });
  });

  test("requires a harness", () => {
    expectInvalid(["setup"]);
  });

  test("rejects an unknown harness", () => {
    expectInvalid(["setup", "aider"]);
  });

  test("rejects a second harness positional", () => {
    expectInvalid(["setup", "codex", "claude-code"]);
  });

  test("rejects an unknown scope", () => {
    expectInvalid(["setup", "codex", "--scope", "global"]);
  });

  test("rejects a missing scope value", () => {
    expectInvalid(["setup", "codex", "--scope"]);
  });

  test("rejects a duplicate scope", () => {
    expectInvalid(["setup", "codex", "--scope", "user", "--scope", "repo"]);
  });

  test("rejects an unknown flag", () => {
    expectInvalid(["setup", "codex", "--bogus"]);
  });
});

describe("parseArgs doctor", () => {
  test("parses with no options", () => {
    expect(parse(["doctor"])).toEqual({ kind: "doctor", json: false });
  });

  test("respects --json", () => {
    expect(parse(["doctor", "--json"])).toEqual({
      kind: "doctor",
      json: true,
    });
  });

  test("rejects an unexpected positional", () => {
    expectInvalid(["doctor", "now"]);
  });

  test("rejects an unknown flag", () => {
    expectInvalid(["doctor", "--bogus"]);
  });
});
