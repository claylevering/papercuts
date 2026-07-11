import { join } from "node:path";

import { PapercutsError } from "../domain/errors";
import type {
  PapercutStore,
  ResolvedRepoContext,
  StoreHealth,
} from "../domain/types";
import { resolvePapercutsPaths } from "../platform/paths";
import type { SetupPlan, SetupRequest } from "../setup/types";
import { CURRENT_SCHEMA_VERSION } from "../storage/sqlite-store";

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: readonly DoctorCheck[];
}

/**
 * Symlink-followed metadata for a single filesystem path. `mode` holds only the
 * permission bits (`st_mode & 0o777`). The context supplies this so the doctor
 * never has to import `node:fs` and tests never touch the real home directory.
 */
export interface DoctorPathInfo {
  mode: number;
  uid: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface DoctorEnvironment {
  cwd: string;
  home: string;
  papercutsHome?: string;
  codexHome?: string;
  pathValue?: string;
}

/**
 * Every external dependency the doctor needs, injected so the checks stay pure
 * and observable. Production callers wire real filesystem, store, repository,
 * and setup implementations; tests wire fakes.
 */
export interface DoctorContext {
  clientVersion: string;
  runtimeVersion: string;
  currentUid: number;
  environment: DoctorEnvironment;
  statPath(path: string): Promise<DoctorPathInfo | null>;
  openStore(path: string): PapercutStore;
  resolveRepoContext(cwd: string): Promise<ResolvedRepoContext | null>;
  planSetup(request: SetupRequest): Promise<SetupPlan>;
}

const EXECUTABLE_NAME = "papercuts";
const EXECUTABLE_BITS = 0o111;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const NON_OWNER_BITS = 0o077;

/**
 * Produce the fixed `{ ok, checks }` diagnostic report. `ok` is true when no
 * check has status `"error"`; warnings (a fresh install, a missing database,
 * a busy store) are informational and do not flip `ok`. This function never
 * throws for a merely-unavailable resource; each boundary failure degrades to
 * a warn or error check with a sanitized, fixed-purpose message.
 */
export async function runDoctor(context: DoctorContext): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(await checkPath(context));
  checks.push(checkClientVersion(context));
  checks.push(checkRuntimeVersion(context));

  const { dataDir, databasePath } = resolveDataPaths(context.environment);

  checks.push(await checkDataDirectory(context, dataDir));
  checks.push(await checkDatabaseFile(context, databasePath));
  checks.push(...(await checkStoreHealth(context, databasePath)));
  checks.push(await checkGitAttribution(context));
  checks.push(await checkSetup(context, "codex", "setup-codex-user"));
  checks.push(await checkSetup(context, "claude-code", "setup-claude-user"));

  return {
    ok: checks.every((check) => check.status !== "error"),
    checks,
  };
}

/**
 * Convenience `statPath` implementation for production callers. It follows
 * symbolic links and returns only permission bits and ownership, never file
 * contents. Not used by the unit tests, which inject their own fake.
 */
export async function defaultStatPath(
  path: string,
): Promise<DoctorPathInfo | null> {
  const { stat } = await import("node:fs/promises");

  try {
    const status = await stat(path);
    return {
      mode: status.mode & 0o777,
      uid: status.uid,
      isFile: status.isFile(),
      isDirectory: status.isDirectory(),
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  }
}

async function checkPath(context: DoctorContext): Promise<DoctorCheck> {
  const pathValue = context.environment.pathValue;

  if (pathValue === undefined || pathValue.length === 0) {
    return warn("path", "PATH is not set, so papercuts cannot be discovered.");
  }

  const directories = pathValue.split(":").filter((entry) => entry.length > 0);

  for (const directory of directories) {
    let info: DoctorPathInfo | null;

    try {
      info = await context.statPath(join(directory, EXECUTABLE_NAME));
    } catch {
      continue;
    }

    if (info !== null && info.isFile && (info.mode & EXECUTABLE_BITS) !== 0) {
      return ok("path", "The papercuts executable is discoverable on PATH.");
    }
  }

  return warn(
    "path",
    "The papercuts executable was not found on PATH; add it or call it by absolute path.",
  );
}

function checkClientVersion(context: DoctorContext): DoctorCheck {
  return ok("cli-version", `papercuts ${context.clientVersion}`);
}

function checkRuntimeVersion(context: DoctorContext): DoctorCheck {
  return ok("runtime-version", `runtime ${context.runtimeVersion}`);
}

async function checkDataDirectory(
  context: DoctorContext,
  dataDir: string,
): Promise<DoctorCheck> {
  let info: DoctorPathInfo | null;

  try {
    info = await context.statPath(dataDir);
  } catch {
    return warn(
      "data-directory",
      "The external data directory could not be inspected.",
    );
  }

  if (info === null) {
    return warn(
      "data-directory",
      "The external data directory does not exist yet; it is created on first capture.",
    );
  }

  if (!info.isDirectory) {
    return error(
      "data-directory",
      "The external data directory path is not a directory.",
    );
  }

  if (info.uid !== context.currentUid) {
    return error(
      "data-directory",
      "The external data directory is owned by another user.",
    );
  }

  if ((info.mode & NON_OWNER_BITS) !== 0) {
    return error(
      "data-directory",
      "The external data directory is not restricted to its owner.",
    );
  }

  if (info.mode !== OWNER_ONLY_DIRECTORY_MODE) {
    return warn(
      "data-directory",
      "The external data directory permissions differ from the expected owner-only mode.",
    );
  }

  return ok(
    "data-directory",
    "The external data directory exists with owner-only permissions.",
  );
}

async function checkDatabaseFile(
  context: DoctorContext,
  databasePath: string,
): Promise<DoctorCheck> {
  let info: DoctorPathInfo | null;

  try {
    info = await context.statPath(databasePath);
  } catch {
    return warn("database-file", "The database file could not be inspected.");
  }

  if (info === null) {
    return warn(
      "database-file",
      "The database has not been created yet; it is created on first capture.",
    );
  }

  if (!info.isFile) {
    return error("database-file", "The database path is not a regular file.");
  }

  if (info.uid !== context.currentUid) {
    return error("database-file", "The database is owned by another user.");
  }

  if ((info.mode & NON_OWNER_BITS) !== 0) {
    return error(
      "database-file",
      "The database is not restricted to its owner.",
    );
  }

  if (info.mode !== OWNER_ONLY_FILE_MODE) {
    return warn(
      "database-file",
      "The database permissions differ from the expected owner-only mode.",
    );
  }

  return ok(
    "database-file",
    "The database exists with owner-only permissions.",
  );
}

async function checkStoreHealth(
  context: DoctorContext,
  databasePath: string,
): Promise<readonly DoctorCheck[]> {
  let present: DoctorPathInfo | null;

  try {
    present = await context.statPath(databasePath);
  } catch {
    present = null;
  }

  if (present === null) {
    return degradedHealthChecks(
      "The database has not been created yet.",
    );
  }

  let health: StoreHealth;
  let store: PapercutStore | null = null;

  try {
    store = context.openStore(databasePath);
    health = store.health();
  } catch (error) {
    return degradedHealthChecks(healthUnavailableMessage(error));
  } finally {
    try {
      store?.close();
    } catch {
      // Closing failures never affect the diagnostic outcome.
    }
  }

  return [
    ok("sqlite-version", `SQLite ${health.sqliteVersion}`),
    checkSchemaVersion(health.schemaVersion),
    checkIntegrity(health.integrity),
    checkWriteLock(health.lockAvailable),
  ];
}

function degradedHealthChecks(message: string): readonly DoctorCheck[] {
  return [
    warn("sqlite-version", message),
    warn("schema-version", message),
    warn("integrity", message),
    warn("write-lock", message),
  ];
}

function healthUnavailableMessage(error: unknown): string {
  if (error instanceof PapercutsError && error.code === "store_busy") {
    return "The database is currently busy; try again shortly.";
  }

  return "The database health could not be determined.";
}

function checkSchemaVersion(schemaVersion: number): DoctorCheck {
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    return error(
      "schema-version",
      "The database schema is newer than this build supports.",
    );
  }

  if (schemaVersion < CURRENT_SCHEMA_VERSION) {
    return warn(
      "schema-version",
      `Schema version ${schemaVersion} is older than this build and migrates on next write.`,
    );
  }

  return ok(
    "schema-version",
    `Schema version ${schemaVersion} matches this build.`,
  );
}

function checkIntegrity(integrity: string): DoctorCheck {
  if (integrity === "ok") {
    return ok("integrity", "The database integrity check passed.");
  }

  return error(
    "integrity",
    "The database integrity check reported a problem.",
  );
}

function checkWriteLock(lockAvailable: boolean): DoctorCheck {
  if (lockAvailable) {
    return ok("write-lock", "A cooperative write lock is available.");
  }

  return warn(
    "write-lock",
    "The store is currently locked by another process.",
  );
}

async function checkGitAttribution(
  context: DoctorContext,
): Promise<DoctorCheck> {
  let resolved: ResolvedRepoContext | null;

  try {
    resolved = await context.resolveRepoContext(context.environment.cwd);
  } catch {
    return warn(
      "git-attribution",
      "Repository attribution is currently unavailable.",
    );
  }

  if (resolved === null) {
    return ok(
      "git-attribution",
      "The current directory is not inside a Git repository.",
    );
  }

  return ok(
    "git-attribution",
    "The current directory maps to a tracked repository.",
  );
}

async function checkSetup(
  context: DoctorContext,
  harness: "codex" | "claude-code",
  name: string,
): Promise<DoctorCheck> {
  const label = harness === "codex" ? "Codex" : "Claude Code";
  let plan: SetupPlan;

  const request: SetupRequest = {
    harness,
    action: "install",
    scope: { kind: "user" },
    home: context.environment.home,
    ...(context.environment.codexHome !== undefined
      ? { codexHome: context.environment.codexHome }
      : {}),
  };

  try {
    plan = await context.planSetup(request);
  } catch {
    return warn(name, `${label} user setup state is unavailable.`);
  }

  switch (plan.state) {
    case "current":
      return ok(name, `${label} user setup is installed and current.`);
    case "absent":
      return ok(name, `${label} user setup is not installed (optional).`);
    case "outdated":
      return warn(
        name,
        `${label} user setup is installed but outdated; re-run setup.`,
      );
    case "conflict":
      return warn(
        name,
        `${label} user setup has a conflict or shadowing that needs manual review.`,
      );
  }
}

function resolveDataPaths(environment: DoctorEnvironment): {
  dataDir: string;
  databasePath: string;
} {
  try {
    return resolvePapercutsPaths(
      environment.papercutsHome === undefined
        ? { home: environment.home }
        : {
            home: environment.home,
            papercutsHome: environment.papercutsHome,
          },
    );
  } catch {
    throw new PapercutsError("invalid_input");
  }
}

function ok(name: string, message: string): DoctorCheck {
  return { name, status: "ok", message };
}

function warn(name: string, message: string): DoctorCheck {
  return { name, status: "warn", message };
}

function error(name: string, message: string): DoctorCheck {
  return { name, status: "error", message };
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
