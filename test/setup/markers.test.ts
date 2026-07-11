import { describe, expect, test } from "bun:test";

import { PapercutsError } from "../../src/domain/errors";
import { BEGIN_MARKER, END_MARKER } from "../../src/setup/content";
import { parseManagedBlock } from "../../src/setup/markers";

function expectSetupConflict(input: string): void {
  try {
    parseManagedBlock(input);
    throw new Error("expected parseManagedBlock to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PapercutsError);
    expect(error).toMatchObject({
      code: "setup_conflict",
      exitCode: 4,
      message: "Managed setup content has changed.",
      retryable: false,
    });
    expect(String(error)).not.toContain("CANARY_DO_NOT_ECHO");
  }
}

describe("managed setup markers", () => {
  test("reports ordinary content as absent", () => {
    expect(parseManagedBlock("# Existing guidance\n")).toEqual({
      kind: "absent",
    });
  });

  test("returns the bounds and version of one valid block", () => {
    const prefix = "before\r\n";
    const managed = `${BEGIN_MARKER}\r\nbody\r\n${END_MARKER}`;
    const input = `${prefix}${managed}\r\nafter`;

    expect(parseManagedBlock(input)).toEqual({
      kind: "present",
      start: prefix.length,
      end: prefix.length + managed.length,
      version: "1",
    });
  });

  test("recognizes an older well-formed version for upgrades", () => {
    const old = "<!-- papercuts:begin v0 -->\nold\n<!-- papercuts:end -->";

    expect(parseManagedBlock(old)).toEqual({
      kind: "present",
      start: 0,
      end: old.length,
      version: "0",
    });
  });

  test("rejects duplicate blocks", () => {
    const block = `${BEGIN_MARKER}\nbody\n${END_MARKER}`;
    expectSetupConflict(`${block}\n${block}\nCANARY_DO_NOT_ECHO`);
  });

  test("rejects a missing end marker", () => {
    expectSetupConflict(`${BEGIN_MARKER}\nCANARY_DO_NOT_ECHO`);
  });

  test("rejects a missing begin marker", () => {
    expectSetupConflict(`CANARY_DO_NOT_ECHO\n${END_MARKER}`);
  });

  test("rejects reversed markers", () => {
    expectSetupConflict(`${END_MARKER}\nCANARY_DO_NOT_ECHO\n${BEGIN_MARKER}`);
  });

  test("rejects nested markers", () => {
    expectSetupConflict(
      `${BEGIN_MARKER}\n${BEGIN_MARKER}\nCANARY_DO_NOT_ECHO\n${END_MARKER}\n${END_MARKER}`,
    );
  });

  test("rejects marker-like malformed content", () => {
    expectSetupConflict(
      "<!-- papercuts:begin -->\nCANARY_DO_NOT_ECHO\n<!-- papercuts:end -->",
    );
  });
});
