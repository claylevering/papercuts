const ERROR_DEFINITIONS = Object.freeze({
  internal_error: Object.freeze({
    exitCode: 1,
    message: "An internal error occurred.",
    retryable: false,
  } as const),
  invalid_input: Object.freeze({
    exitCode: 2,
    message: "Invalid input.",
    retryable: false,
  } as const),
  not_found: Object.freeze({
    exitCode: 3,
    message: "The requested item was not found.",
    retryable: false,
  } as const),
  setup_conflict: Object.freeze({
    exitCode: 4,
    message: "Managed setup content has changed.",
    retryable: false,
  } as const),
  store_busy: Object.freeze({
    exitCode: 5,
    message: "The papercuts store is busy; try again.",
    retryable: true,
  } as const),
  safety_failure: Object.freeze({
    exitCode: 6,
    message: "The operation failed a safety check.",
    retryable: false,
  } as const),
} as const);

export type PapercutsErrorCode = keyof typeof ERROR_DEFINITIONS;
type PapercutsExitCode =
  (typeof ERROR_DEFINITIONS)[PapercutsErrorCode]["exitCode"];

export class PapercutsError extends Error {
  override readonly name = "PapercutsError";
  readonly code: PapercutsErrorCode;
  readonly exitCode: PapercutsExitCode;
  readonly retryable: boolean;

  constructor(code: PapercutsErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.code = code;
    this.exitCode = definition.exitCode;
    this.retryable = definition.retryable;
  }

  toJSON(): {
    code: PapercutsErrorCode;
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
