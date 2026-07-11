import type { ScreenedText } from "./types";

type PapercutsExitCode = 1 | 2 | 3 | 4 | 5 | 6;

export class PapercutsError extends Error {
  override readonly name = "PapercutsError";
  readonly code: string;
  readonly exitCode: PapercutsExitCode;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    message: ScreenedText;
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
