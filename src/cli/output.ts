import { PapercutsError } from "../domain/errors";

/**
 * Minimal writer surface consumed by the output helpers. The CLI runtime's
 * `CliIo` is a structural superset, so it satisfies this contract directly.
 */
export interface OutputStreams {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

/** The only error-object fields ever exposed in a JSON failure envelope. */
export interface JsonEnvelopeError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface JsonSuccessEnvelope<T> {
  version: 1;
  ok: true;
  command: string;
  data: T;
  warnings: readonly string[];
}

export interface JsonFailureEnvelope {
  version: 1;
  ok: false;
  command: string;
  error: JsonEnvelopeError;
}

/**
 * Build a success envelope with exactly the fixed top-level fields, in the
 * order `{version, ok, command, data, warnings}`. Warnings default to empty.
 */
export function jsonSuccessEnvelope<T>(
  command: string,
  data: T,
  warnings: readonly string[] = [],
): JsonSuccessEnvelope<T> {
  return {
    version: 1,
    ok: true,
    command,
    data,
    warnings,
  };
}

/**
 * Build a failure envelope from any throwable. A {@link PapercutsError} keeps
 * its code/message/retryable; anything else is sanitized to `internal_error`,
 * so no raw diagnostic text ever reaches the envelope.
 */
export function jsonFailureEnvelope(
  command: string,
  error: unknown,
): JsonFailureEnvelope {
  return {
    version: 1,
    ok: false,
    command,
    error: toEnvelopeError(error),
  };
}

/**
 * Serialize an envelope to exactly one JSON object followed by a single
 * newline, with no ANSI or surrounding prose.
 */
export function serializeEnvelope(
  envelope: JsonSuccessEnvelope<unknown> | JsonFailureEnvelope,
): string {
  return `${JSON.stringify(envelope)}\n`;
}

/** Write a JSON success envelope to stdout; stderr is untouched. */
export function writeJsonSuccess<T>(
  streams: OutputStreams,
  command: string,
  data: T,
  warnings: readonly string[] = [],
): void {
  streams.writeStdout(
    serializeEnvelope(jsonSuccessEnvelope(command, data, warnings)),
  );
}

/**
 * Write a handled error as a JSON failure envelope to stdout. Stderr is left
 * empty so JSON-mode consumers see exactly one object on stdout and nothing
 * else.
 */
export function writeJsonError(
  streams: OutputStreams,
  command: string,
  error: unknown,
): void {
  streams.writeStdout(serializeEnvelope(jsonFailureEnvelope(command, error)));
}

/**
 * Write a handled error as a sanitized single-line message to stderr. Stdout is
 * left empty. The message is always a fixed registry message, never raw input.
 */
export function writeHumanError(
  streams: OutputStreams,
  error: unknown,
): void {
  streams.writeStderr(`${toEnvelopeError(error).message}\n`);
}

/**
 * Map any throwable to a stable process exit code. A {@link PapercutsError}
 * yields its registry exit code (1-6); anything else is treated as an internal
 * failure with exit code 1.
 */
export function exitCodeForError(error: unknown): number {
  return error instanceof PapercutsError ? error.exitCode : 1;
}

function toEnvelopeError(error: unknown): JsonEnvelopeError {
  const papercutsError =
    error instanceof PapercutsError
      ? error
      : new PapercutsError("internal_error");

  return {
    code: papercutsError.code,
    message: papercutsError.message,
    retryable: papercutsError.retryable,
  };
}
