import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPathHasNoSymlinkComponents,
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../../src/platform/private-files";

function withTemporaryRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "papercuts-private-files-"));

  try {
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

async function withTemporaryRootAsync(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "papercuts-private-files-"));

  try {
    await run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("private file permissions", () => {
  test("creates an owner-only directory", () => {
    withTemporaryRoot((root) => {
      const directory = join(root, "nested", "data");

      ensurePrivateDirectorySync(directory);

      expect(existsSync(directory)).toBe(true);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    });
  });

  test("corrects an existing directory to owner-only mode", () => {
    withTemporaryRoot((root) => {
      const directory = join(root, "data");
      mkdirSync(directory, { mode: 0o777 });
      chmodSync(directory, 0o777);

      ensurePrivateDirectorySync(directory);

      expect(statSync(directory).mode & 0o777).toBe(0o700);
    });
  });

  test("corrects an existing file to owner-only mode", () => {
    withTemporaryRoot((root) => {
      const file = join(root, "papercuts.sqlite3");
      closeSync(openSync(file, "w", 0o666));
      chmodSync(file, 0o666);

      ensurePrivateFileSync(file);

      expect(statSync(file).mode & 0o777).toBe(0o600);
    });
  });
});

describe("assertPathHasNoSymlinkComponents", () => {
  test("rejects a non-absolute target", async () => {
    await withTemporaryRootAsync(async (root) => {
      await expect(
        assertPathHasNoSymlinkComponents(root, "relative/target"),
      ).rejects.toThrow("Scope root and target path must be absolute.");
    });
  });

  test("rejects a lexical scope escape", async () => {
    await withTemporaryRootAsync(async (root) => {
      await expect(
        assertPathHasNoSymlinkComponents(root, join(root, "..", "outside")),
      ).rejects.toThrow("Target path is outside the canonical scope root.");
    });
  });

  test("rejects a symlinked parent component", async () => {
    await withTemporaryRootAsync(async (root) => {
      const realDirectory = join(root, "real");
      const linkedDirectory = join(root, "linked");
      mkdirSync(realDirectory);
      symlinkSync(realDirectory, linkedDirectory, "dir");

      await expect(
        assertPathHasNoSymlinkComponents(root, join(linkedDirectory, "file")),
      ).rejects.toThrow("Path contains a symbolic link.");
    });
  });

  test("rejects a symlinked target", async () => {
    await withTemporaryRootAsync(async (root) => {
      const target = join(root, "target");
      symlinkSync(join(root, "missing"), target, "file");

      await expect(
        assertPathHasNoSymlinkComponents(root, target),
      ).rejects.toThrow("Path contains a symbolic link.");
    });
  });

  test("allows a non-existent tail beneath ordinary components", async () => {
    await withTemporaryRootAsync(async (root) => {
      const directory = join(root, "ordinary");
      mkdirSync(directory);

      await expect(
        assertPathHasNoSymlinkComponents(
          root,
          join(directory, "not-created", "target"),
        ),
      ).resolves.toBeUndefined();
    });
  });
});
