import { describe, expect, test } from "bun:test";

import { resolvePapercutsPaths } from "../../src/platform/paths";

describe("resolvePapercutsPaths", () => {
  test("uses the macOS Application Support directory by default", () => {
    expect(resolvePapercutsPaths({ home: "/Users/example" })).toEqual({
      dataDir: "/Users/example/Library/Application Support/papercuts",
      databasePath:
        "/Users/example/Library/Application Support/papercuts/papercuts.sqlite3",
    });
  });

  test("treats PAPERCUTS_HOME as the data directory", () => {
    expect(
      resolvePapercutsPaths({
        home: "/Users/example",
        papercutsHome: "/tmp/papercuts-profile",
      }),
    ).toEqual({
      dataDir: "/tmp/papercuts-profile",
      databasePath: "/tmp/papercuts-profile/papercuts.sqlite3",
    });
  });

  test("rejects a relative PAPERCUTS_HOME override", () => {
    expect(() =>
      resolvePapercutsPaths({
        home: "/Users/example",
        papercutsHome: "relative/profile",
      }),
    ).toThrow("PAPERCUTS_HOME must be an absolute path.");
  });
});
