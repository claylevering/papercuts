import { chmodSync, mkdirSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function ensurePrivateDirectorySync(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: true });
  chmodSync(path, 0o700);
}

export function ensurePrivateFileSync(path: string): void {
  chmodSync(path, 0o600);
}

export async function assertPathHasNoSymlinkComponents(
  canonicalScopeRoot: string,
  targetPath: string,
): Promise<void> {
  if (!isAbsolute(canonicalScopeRoot) || !isAbsolute(targetPath)) {
    throw new Error("Scope root and target path must be absolute.");
  }

  const scopeRoot = resolve(canonicalScopeRoot);
  const target = resolve(targetPath);
  const targetRelativeToScope = relative(scopeRoot, target);

  if (
    targetRelativeToScope === ".." ||
    targetRelativeToScope.startsWith(`..${sep}`) ||
    isAbsolute(targetRelativeToScope)
  ) {
    throw new Error("Target path is outside the canonical scope root.");
  }

  const components =
    targetRelativeToScope === "" ? [] : targetRelativeToScope.split(sep);
  let current = scopeRoot;

  for (const component of ["", ...components]) {
    if (component !== "") {
      current = join(current, component);
    }

    let status;

    try {
      status = await lstat(current);
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }

      throw new Error("Unable to inspect path components.");
    }

    if (status.isSymbolicLink()) {
      throw new Error("Path contains a symbolic link.");
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
