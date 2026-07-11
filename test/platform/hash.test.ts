import { describe, expect, test } from "bun:test";

import { sha256Hex } from "../../src/platform/hash";

describe("sha256Hex", () => {
  const expected =
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

  test("hashes string input as lowercase SHA-256 hex", () => {
    expect(sha256Hex("abc")).toBe(expected);
  });

  test("hashes Uint8Array input as lowercase SHA-256 hex", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(expected);
  });
});
