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

  test("accepts exact standalone marker lines with each supported newline style", () => {
    for (const newline of ["\n", "\r\n", "\r"] as const) {
      const prefix = `before${newline}`;
      const managed = `${BEGIN_MARKER}${newline}body${newline}${END_MARKER}`;
      const input = `${prefix}${managed}${newline}after`;

      expect(parseManagedBlock(input)).toEqual({
        kind: "present",
        start: prefix.length,
        end: prefix.length + managed.length,
        version: "1",
      });
    }
  });

  test("rejects exact markers embedded in surrounding text", () => {
    expectSetupConflict(
      `prefix ${BEGIN_MARKER}\nCANARY_DO_NOT_ECHO\n${END_MARKER} suffix`,
    );
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

  test("rejects malformed whitespace and comment marker variants", () => {
    for (const begin of [
      ` ${BEGIN_MARKER}`,
      `${BEGIN_MARKER} `,
      "<!--papercuts:begin v1 -->",
      "<!--  papercuts:begin v1 -->",
      "<!-- papercuts:begin  v1 -->",
      "<!-- papercuts :begin v1 -->",
      "<!-- papercuts: begin v1 -->",
      "<!-- PAPERCUTS:BEGIN v1 -->",
      "<!-- papercuts-begin v1 -->",
      "<!-- papercuts:begin v1-->",
      "<!-- prefix papercuts:begin v1 -->",
    ]) {
      expectSetupConflict(
        `${begin}\nCANARY_DO_NOT_ECHO\n${END_MARKER}`,
      );
    }

    expectSetupConflict(
      `${BEGIN_MARKER}\nCANARY_DO_NOT_ECHO\n${END_MARKER} trailing`,
    );

    for (const [begin, end] of [
      ["<!-- PAPERCUTS:BEGIN v1 -->", "<!-- PAPERCUTS:END -->"],
      ["<!-- papercuts : begin v1 -->", "<!-- papercuts : end -->"],
      ["<!-- papercuts-begin v1 -->", "<!-- papercuts-end -->"],
      ["<!-- papercuts begin v1 -->", "<!-- papercuts end -->"],
    ] as const) {
      expectSetupConflict(`${begin}\nCANARY_DO_NOT_ECHO\n${end}`);
    }
  });
});
