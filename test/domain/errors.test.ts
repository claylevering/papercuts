import { describe, expect, test } from "bun:test";

import {
  PapercutsError,
  type PapercutsErrorCode,
} from "../../src/domain/errors";
import { redact } from "../../src/security/redactor";

const EXPECTED_ERRORS = [
  ["internal_error", 1, false, "An internal error occurred."],
  ["invalid_input", 2, false, "Invalid input."],
  ["not_found", 3, false, "The requested item was not found."],
  ["setup_conflict", 4, false, "Managed setup content has changed."],
  ["store_busy", 5, true, "The papercuts store is busy; try again."],
  ["safety_failure", 6, false, "The operation failed a safety check."],
] as const satisfies readonly (readonly [
  PapercutsErrorCode,
  number,
  boolean,
  string,
])[];

describe("PapercutsError", () => {
  for (const [code, exitCode, retryable, message] of EXPECTED_ERRORS) {
    test(`derives the ${code} contract from its code`, () => {
      const error = new PapercutsError(code);

      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.exitCode).toBe(exitCode);
      expect(error.retryable).toBe(retryable);
      expect(error.message).toBe(message);
      expect(error.toJSON()).toEqual({
        code,
        exitCode,
        message,
        retryable,
      });
    });
  }

  test("serializes only the fixed code-derived fields", () => {
    const error = new PapercutsError("internal_error");
    Object.defineProperty(error, "cause", {
      enumerable: true,
      value: "internal diagnostic",
    });

    expect(JSON.parse(JSON.stringify(error))).toEqual(error.toJSON());
  });

  test("runtime assignment cannot replace the serialized fixed message", () => {
    const error = new PapercutsError("internal_error");
    const fixedMessage = error.toJSON().message;

    expect(Reflect.set(error, "message", "runtime raw diagnostic")).toBe(false);
    expect(error.message).toBe(fixedMessage);
    expect(error.toJSON().message).toBe(fixedMessage);
  });

  test("runtime redefinition cannot replace the serialized fixed message", () => {
    const error = new PapercutsError("internal_error");
    const fixedMessage = error.toJSON().message;

    expect(() =>
      Object.defineProperty(error, "message", {
        value: "runtime raw diagnostic",
      }),
    ).toThrow(TypeError);
    expect(error.message).toBe(fixedMessage);
    expect(error.toJSON().message).toBe(fixedMessage);
  });

  for (const property of [
    "message",
    "code",
    "exitCode",
    "retryable",
  ] as const) {
    test(`defines ${property} as an immutable own property`, () => {
      const error = new PapercutsError("internal_error");
      const descriptor = Object.getOwnPropertyDescriptor(error, property);

      expect(descriptor).toBeDefined();
      expect(descriptor?.writable).toBe(false);
      expect(descriptor?.configurable).toBe(false);
    });
  }

  test("preserves the Error name and stack", () => {
    const error = new PapercutsError("internal_error");

    expect(error.name).toBe("PapercutsError");
    expect(error.stack).toContain("PapercutsError");
  });

  test("rejects every caller-supplied message shape at compile time", () => {
    if (false) {
      const screened = redact("Caller detail.").text;

      // @ts-expect-error PapercutsError accepts no second argument.
      new PapercutsError("internal_error", screened);

      // @ts-expect-error PapercutsError accepts a code, not a message object.
      new PapercutsError({
        code: "internal_error",
        exitCode: 1,
        message: screened,
        retryable: false,
      });

      // @ts-expect-error PapercutsErrorCode is a closed registry.
      new PapercutsError("custom_error");
    }

    expect(true).toBe(true);
  });
});
