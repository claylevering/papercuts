import { PapercutsError } from "../domain/errors";

/**
 * Read stdin into a decoded string under a hard byte bound.
 *
 * Bytes are counted incrementally as chunks arrive so an oversized or infinite
 * stream is rejected without buffering more than one chunk past the limit. Only
 * after the byte bound holds are the bytes checked for NUL and decoded as
 * strict UTF-8. Every rejection is a sanitized {@link PapercutsError} with code
 * `invalid_input`; rejected or partial bytes are never echoed.
 */
export async function readBoundedStdin(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for await (const chunk of stream) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      throw new PapercutsError("invalid_input");
    }
    chunks.push(chunk);
  }

  const combined = concatenate(chunks, totalBytes);

  if (combined.includes(0)) {
    throw new PapercutsError("invalid_input");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw new PapercutsError("invalid_input");
  }
}

function concatenate(
  chunks: readonly Uint8Array[],
  totalBytes: number,
): Uint8Array {
  const combined = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return combined;
}
