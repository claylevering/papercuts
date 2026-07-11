import type { ScreenedText } from "./types";

type PapercutsExitCode = 1 | 2 | 3 | 4 | 5 | 6;
declare const safeMessageBrand: unique symbol;

export type SafeMessage = string & {
  readonly [safeMessageBrand]: true;
};

export function safeMessage(
  strings: TemplateStringsArray,
  ...substitutions: never[]
): SafeMessage {
  if (
    substitutions.length !== 0 ||
    strings.length !== 1 ||
    !Object.isFrozen(strings) ||
    !Object.isFrozen(strings.raw)
  ) {
    throw new TypeError(
      "Safe messages must be fixed template literals without interpolations.",
    );
  }

  const message = strings[0];

  if (message === undefined) {
    throw new TypeError(
      "Safe messages must be fixed template literals without interpolations.",
    );
  }

  return message as SafeMessage;
}

export class PapercutsError extends Error {
  override readonly name = "PapercutsError";
  readonly code: string;
  readonly exitCode: PapercutsExitCode;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    message: SafeMessage | ScreenedText;
    exitCode: PapercutsExitCode;
    retryable: boolean;
  }) {
    super(input.message);
    this.code = input.code;
    this.exitCode = input.exitCode;
    this.retryable = input.retryable;
  }

  toJSON(): {
    code: string;
    exitCode: PapercutsExitCode;
    message: string;
    retryable: boolean;
  } {
    return {
      code: this.code,
      exitCode: this.exitCode,
      message: this.message,
      retryable: this.retryable,
    };
  }
}
