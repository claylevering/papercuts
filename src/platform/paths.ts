import { isAbsolute, join, normalize } from "node:path";

export function resolvePapercutsPaths(input: {
  home: string;
  papercutsHome?: string;
}): { dataDir: string; databasePath: string } {
  if (
    input.papercutsHome !== undefined &&
    !isAbsolute(input.papercutsHome)
  ) {
    throw new Error("PAPERCUTS_HOME must be an absolute path.");
  }

  const dataDir =
    input.papercutsHome === undefined
      ? join(input.home, "Library", "Application Support", "papercuts")
      : normalize(input.papercutsHome);

  return {
    dataDir,
    databasePath: join(dataDir, "papercuts.sqlite3"),
  };
}
