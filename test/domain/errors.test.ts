import { describe, expect, test } from "bun:test";

import * as errorModule from "../../src/domain/errors";
import { PapercutsError } from "../../src/domain/errors";
import { redact } from "../../src/security/redactor";

// @ts-expect-error SafeMessage is intentionally not part of the public API.
type RemovedSafeMessage = import("../../src/domain/errors").SafeMessage;

describe("PapercutsError", () => {
  test("accepts a screened fixed message and omits cause from JSON", () => {
    const message = redact("A fixed failure occurred.").text;
    const error = new PapercutsError({
      code: "fixed_failure",
      exitCode: 1,
      message,
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

  test("exposes only a screened compile-time message boundary", () => {
    if (false) {
      const runtimeMessage = "runtime detail";

      new PapercutsError({
        code: "unsafe_failure",
        exitCode: 1,
        // @ts-expect-error PapercutsError rejects unbranded runtime strings.
        message: runtimeMessage,
        retryable: false,
      });

      // @ts-expect-error safeMessage is intentionally not exported.
      errorModule.safeMessage;
    }

    expect(true).toBe(true);
  });
});
