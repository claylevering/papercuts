import { describe, expect, test } from "bun:test";

import {
  PapercutsError,
  safeMessage,
  type SafeMessage,
} from "../../src/domain/errors";
import { redact } from "../../src/security/redactor";

describe("PapercutsError", () => {
  test("accepts a fixed safe message and omits cause from JSON", () => {
    const error = new PapercutsError({
      code: "fixed_failure",
      exitCode: 1,
      message: safeMessage`A fixed failure occurred.`,
      retryable: false,
    });
    Object.defineProperty(error, "cause", {
      enumerable: true,
      value: "internal diagnostic",
    });

    expect(String(error.message)).toBe("A fixed failure occurred.");
    expect(error.toJSON()).toEqual({
      code: "fixed_failure",
      exitCode: 1,
      message: "A fixed failure occurred.",
      retryable: false,
    });
    expect(JSON.parse(JSON.stringify(error))).toEqual(error.toJSON());
  });

  test("accepts an already-screened message", () => {
    const message = redact("A screened diagnostic.").text;

    const error = new PapercutsError({
      code: "screened_failure",
      exitCode: 6,
      message,
      retryable: false,
    });

    expect(error.message).toBe(message);
  });

  test("rejects interpolated safe-message templates at runtime", () => {
    const strings = Object.assign(["Failure: ", ""], {
      raw: ["Failure: ", ""],
    }) as unknown as TemplateStringsArray;
    const invoke = safeMessage as unknown as (
      template: TemplateStringsArray,
      ...values: string[]
    ) => SafeMessage;

    expect(() => invoke(strings, "dynamic detail")).toThrow(
      "Safe messages must be fixed template literals without interpolations.",
    );
  });

  test("exposes compile-time safe message boundaries", () => {
    if (false) {
      const runtimeMessage = "runtime detail";

      new PapercutsError({
        code: "unsafe_failure",
        exitCode: 1,
        // @ts-expect-error PapercutsError rejects unbranded runtime strings.
        message: runtimeMessage,
        retryable: false,
      });

      // @ts-expect-error Safe-message templates cannot interpolate values.
      safeMessage`Failure: ${runtimeMessage}`;
    }

    expect(true).toBe(true);
  });
});
