import { describe, expect, test } from "bun:test";

import { PapercutsError } from "../../src/domain/errors";
import { readBoundedStdin } from "../../src/cli/input";

const MAX_BYTES = 65_536;
const encoder = new TextEncoder();

async function* streamOf(
  ...chunks: readonly Uint8Array[]
): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function bytes(...values: readonly number[]): Uint8Array {
  return Uint8Array.from(values);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected readBoundedStdin to reject");
    },
    (error: unknown) => error,
  );
}

describe("readBoundedStdin", () => {
  test("decodes a single UTF-8 chunk", async () => {
    const result = await readBoundedStdin(
      streamOf(encoder.encode("hello world")),
      MAX_BYTES,
    );

    expect(result).toBe("hello world");
  });

  test("concatenates multiple chunks in order", async () => {
    const result = await readBoundedStdin(
      streamOf(
        encoder.encode("foo "),
        encoder.encode("bar "),
        encoder.encode("baz"),
      ),
      MAX_BYTES,
    );

    expect(result).toBe("foo bar baz");
  });

  test("decodes a multi-byte character split across a chunk boundary", async () => {
    const emoji = encoder.encode("😀");

    const result = await readBoundedStdin(
      streamOf(emoji.slice(0, 2), emoji.slice(2)),
      MAX_BYTES,
    );

    expect(result).toBe("😀");
  });

  test("returns an empty string for an empty stream", async () => {
    const result = await readBoundedStdin(streamOf(), MAX_BYTES);

    expect(result).toBe("");
  });

  test("accepts input at exactly the byte bound", async () => {
    const payload = "a".repeat(MAX_BYTES);

    const result = await readBoundedStdin(
      streamOf(encoder.encode(payload)),
      MAX_BYTES,
    );

    expect(result).toHaveLength(MAX_BYTES);
  });

  test("accepts the byte bound delivered across chunks that straddle it", async () => {
    const head = encoder.encode("a".repeat(MAX_BYTES - 1));
    const tail = encoder.encode("b");

    const result = await readBoundedStdin(streamOf(head, tail), MAX_BYTES);

    expect(result).toHaveLength(MAX_BYTES);
  });

  test("rejects input one byte over the bound in a single chunk", async () => {
    const payload = "a".repeat(MAX_BYTES + 1);

    await expect(
      readBoundedStdin(streamOf(encoder.encode(payload)), MAX_BYTES),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("rejects when a later chunk pushes the total one byte over the bound", async () => {
    const head = encoder.encode("a".repeat(MAX_BYTES));
    const tail = encoder.encode("b");

    await expect(
      readBoundedStdin(streamOf(head, tail), MAX_BYTES),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("stops reading once the bound is exceeded", async () => {
    let readPastLimit = false;
    async function* greedy(): AsyncGenerator<Uint8Array> {
      yield encoder.encode("a".repeat(MAX_BYTES + 1));
      readPastLimit = true;
      yield encoder.encode("this chunk must never be requested");
    }

    await expect(
      readBoundedStdin(greedy(), MAX_BYTES),
    ).rejects.toBeInstanceOf(PapercutsError);
    expect(readPastLimit).toBe(false);
  });

  test("rejects a lone continuation byte with a fatal UTF-8 decode", async () => {
    await expect(
      readBoundedStdin(streamOf(bytes(0x80)), MAX_BYTES),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("rejects a truncated multi-byte sequence", async () => {
    await expect(
      readBoundedStdin(streamOf(bytes(0xf0, 0x9f)), MAX_BYTES),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("rejects a NUL byte between two valid chunks", async () => {
    await expect(
      readBoundedStdin(
        streamOf(encoder.encode("before"), bytes(0x00), encoder.encode("after")),
        MAX_BYTES,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("rejects a NUL byte inside an otherwise valid chunk", async () => {
    await expect(
      readBoundedStdin(streamOf(bytes(0x61, 0x00, 0x62)), MAX_BYTES),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("raises invalid_input without echoing malformed bytes", async () => {
    const canary = "MALFORMED-CANARY-VALUE";
    const chunk = new Uint8Array([...encoder.encode(canary), 0xff]);

    const error = await rejection(readBoundedStdin(streamOf(chunk), MAX_BYTES));

    expect(error).toBeInstanceOf(PapercutsError);
    expect((error as PapercutsError).code).toBe("invalid_input");
    expect((error as PapercutsError).message).toBe("Invalid input.");
    expect((error as PapercutsError).message).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
  });

  test("raises invalid_input without echoing bytes around a NUL", async () => {
    const canary = "NUL-CANARY-VALUE";
    const chunk = new Uint8Array([...encoder.encode(canary), 0x00]);

    const error = await rejection(readBoundedStdin(streamOf(chunk), MAX_BYTES));

    expect(error).toBeInstanceOf(PapercutsError);
    expect((error as PapercutsError).code).toBe("invalid_input");
    expect((error as PapercutsError).message).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
  });

  test("raises invalid_input without echoing oversize content", async () => {
    const canary = "OVERSIZE-CANARY-VALUE";
    const payload = canary + "a".repeat(MAX_BYTES + 1);

    const error = await rejection(
      readBoundedStdin(streamOf(encoder.encode(payload)), MAX_BYTES),
    );

    expect(error).toBeInstanceOf(PapercutsError);
    expect((error as PapercutsError).code).toBe("invalid_input");
    expect((error as PapercutsError).message).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
  });
});
