import { describe, expect, test } from "bun:test";

import { PapercutsError, type PapercutsErrorCode } from "../../src/domain/errors";
import {
  exitCodeForError,
  jsonFailureEnvelope,
  jsonSuccessEnvelope,
  serializeEnvelope,
  writeHumanError,
  writeJsonError,
  writeJsonSuccess,
} from "../../src/cli/output";

function createSink() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    writeStdout(text: string): void {
      stdout.push(text);
    },
    writeStderr(text: string): void {
      stderr.push(text);
    },
    stdoutText(): string {
      return stdout.join("");
    },
    stderrText(): string {
      return stderr.join("");
    },
  };
}

const EXPECTED_EXIT_CODES = [
  ["internal_error", 1],
  ["invalid_input", 2],
  ["not_found", 3],
  ["setup_conflict", 4],
  ["store_busy", 5],
  ["safety_failure", 6],
] as const satisfies readonly (readonly [PapercutsErrorCode, number])[];

describe("jsonSuccessEnvelope", () => {
  test("builds exactly the fixed success fields in order", () => {
    const envelope = jsonSuccessEnvelope("add", { id: "abc" }, ["a warning"]);

    expect(envelope).toEqual({
      version: 1,
      ok: true,
      command: "add",
      data: { id: "abc" },
      warnings: ["a warning"],
    });
    expect(Object.keys(envelope)).toEqual([
      "version",
      "ok",
      "command",
      "data",
      "warnings",
    ]);
  });

  test("defaults warnings to an empty array", () => {
    const envelope = jsonSuccessEnvelope("list", {
      scope: { kind: "all" },
      records: [],
    });

    expect(envelope.warnings).toEqual([]);
    expect(Object.keys(envelope)).toContain("warnings");
  });
});

describe("jsonFailureEnvelope", () => {
  test("builds the failure envelope from a PapercutsError with only code/message/retryable", () => {
    const envelope = jsonFailureEnvelope(
      "setup",
      new PapercutsError("setup_conflict"),
    );

    expect(envelope).toEqual({
      version: 1,
      ok: false,
      command: "setup",
      error: {
        code: "setup_conflict",
        message: "Managed setup content has changed.",
        retryable: false,
      },
    });
    expect(Object.keys(envelope)).toEqual([
      "version",
      "ok",
      "command",
      "error",
    ]);
    expect(Object.keys(envelope.error)).toEqual([
      "code",
      "message",
      "retryable",
    ]);
    expect(envelope.error).not.toHaveProperty("exitCode");
  });

  test("preserves retryable true for store_busy", () => {
    const envelope = jsonFailureEnvelope("list", new PapercutsError("store_busy"));

    expect(envelope.error.retryable).toBe(true);
    expect(envelope.error.code).toBe("store_busy");
  });

  test("sanitizes an unknown error to internal_error without leaking its text", () => {
    const canary = "RAW-DIAGNOSTIC-CANARY";

    const envelope = jsonFailureEnvelope("doctor", new Error(canary));

    expect(envelope.error).toEqual({
      code: "internal_error",
      message: "An internal error occurred.",
      retryable: false,
    });
    expect(JSON.stringify(envelope)).not.toContain(canary);
  });

  test("sanitizes a non-error throwable to internal_error", () => {
    const canary = "STRING-THROWABLE-CANARY";

    const envelope = jsonFailureEnvelope("add", canary);

    expect(envelope.error.code).toBe("internal_error");
    expect(JSON.stringify(envelope)).not.toContain(canary);
  });
});

describe("serializeEnvelope", () => {
  test("emits exactly one JSON object followed by a single trailing newline", () => {
    const serialized = serializeEnvelope(
      jsonSuccessEnvelope("version", { version: "0.1.0" }),
    );

    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.slice(0, -1)).not.toContain("\n");
    expect(serialized.match(/\n/g)).toHaveLength(1);
    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      ok: true,
      command: "version",
      data: { version: "0.1.0" },
      warnings: [],
    });
  });

  test("contains no ANSI escape sequences", () => {
    const serialized = serializeEnvelope(
      jsonFailureEnvelope("add", new PapercutsError("invalid_input")),
    );

    expect(serialized).not.toContain("\u001b");
  });

  test("serializes the success envelope with fixed field order", () => {
    const serialized = serializeEnvelope(jsonSuccessEnvelope("add", {}, []));

    expect(serialized).toBe(
      '{"version":1,"ok":true,"command":"add","data":{},"warnings":[]}\n',
    );
  });

  test("serializes the failure envelope with fixed field order", () => {
    const serialized = serializeEnvelope(
      jsonFailureEnvelope("setup", new PapercutsError("setup_conflict")),
    );

    expect(serialized).toBe(
      '{"version":1,"ok":false,"command":"setup","error":' +
        '{"code":"setup_conflict","message":"Managed setup content has changed.",' +
        '"retryable":false}}\n',
    );
  });
});

describe("writeJsonSuccess", () => {
  test("writes one envelope to stdout and nothing to stderr", () => {
    const sink = createSink();

    writeJsonSuccess(sink, "add", { id: "abc" });

    expect(sink.stderrText()).toBe("");
    expect(sink.stdoutText()).toBe(
      serializeEnvelope(jsonSuccessEnvelope("add", { id: "abc" })),
    );
    expect(sink.stdoutText().match(/\n/g)).toHaveLength(1);
  });
});

describe("writeJsonError", () => {
  test("writes the failure envelope to stdout and leaves stderr empty", () => {
    const sink = createSink();

    writeJsonError(sink, "setup", new PapercutsError("setup_conflict"));

    expect(sink.stderrText()).toBe("");
    expect(sink.stdoutText()).toBe(
      serializeEnvelope(
        jsonFailureEnvelope("setup", new PapercutsError("setup_conflict")),
      ),
    );
  });

  test("leaves stderr empty even when sanitizing an unknown error", () => {
    const canary = "JSON-HANDLED-CANARY";
    const sink = createSink();

    writeJsonError(sink, "doctor", new Error(canary));

    expect(sink.stderrText()).toBe("");
    expect(sink.stdoutText()).not.toContain(canary);
  });
});

describe("writeHumanError", () => {
  test("writes a sanitized message to stderr and nothing to stdout", () => {
    const sink = createSink();

    writeHumanError(sink, new PapercutsError("store_busy"));

    expect(sink.stdoutText()).toBe("");
    expect(sink.stderrText()).toBe("The papercuts store is busy; try again.\n");
  });

  test("sanitizes an unknown error without leaking its text", () => {
    const canary = "RAW-HUMAN-CANARY";
    const sink = createSink();

    writeHumanError(sink, new Error(canary));

    expect(sink.stdoutText()).toBe("");
    expect(sink.stderrText()).not.toContain(canary);
    expect(sink.stderrText()).toBe("An internal error occurred.\n");
  });
});

describe("exitCodeForError", () => {
  for (const [code, exitCode] of EXPECTED_EXIT_CODES) {
    test(`maps ${code} to exit code ${exitCode}`, () => {
      expect(exitCodeForError(new PapercutsError(code))).toBe(exitCode);
    });
  }

  test("maps an unknown Error to exit code 1", () => {
    expect(exitCodeForError(new Error("boom"))).toBe(1);
  });

  test("maps a non-error throwable to exit code 1", () => {
    expect(exitCodeForError("nope")).toBe(1);
  });
});
