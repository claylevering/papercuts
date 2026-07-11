import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { PapercutsError } from "../domain/errors";
import { sha256Hex } from "../platform/hash";
import { assertPathHasNoSymlinkComponents } from "../platform/private-files";
import { renderClaudeInstructions, renderCodexInstructions } from "./content";
import { parseManagedBlock } from "./markers";
import type { PlannedFileMutation, SetupPlan } from "./types";

type Newline = "\n" | "\r\n" | "\r";

export interface ApplySetupOptions {
  afterTempFileFlush?(context: {
    mutation: PlannedFileMutation;
    tempPath: string;
  }): void | Promise<void>;
}

interface Preimage {
  exists: boolean;
  bytes: Uint8Array;
  mode: number;
}

const LOCK_RETRY_COUNT = 200;
const LOCK_RETRY_DELAY_MS = 5;

export async function applySetup(
  plan: SetupPlan,
  options: ApplySetupOptions = {},
): Promise<void> {
  let createdScopeDirectories: readonly string[] = [];
  let applyCompleted = false;

  try {
    if (plan.state === "conflict") {
      throw new PapercutsError("setup_conflict");
    }

    if (plan.mutations.length === 0) {
      return;
    }

    if (plan.harness === "generic") {
      throw new PapercutsError("setup_conflict");
    }

    const uniqueTargets = new Set<string>();

    for (const mutation of plan.mutations) {
      const targetPath = validateTargetPath(
        plan.canonicalScopeRoot,
        mutation.path,
      );

      if (uniqueTargets.has(targetPath) || mutation.createMode !== 0o600) {
        throw new PapercutsError("setup_conflict");
      }

      uniqueTargets.add(targetPath);
    }

    createdScopeDirectories = await ensureCanonicalScopeRoot(
      plan.canonicalScopeRoot,
      plan.action === "install" &&
        plan.mutations.every((mutation) => mutation.nextContent !== null),
    );
    const canonicalScopeRoot = await validateCanonicalScopeRoot(
      plan.canonicalScopeRoot,
    );

    for (const mutation of plan.mutations) {
      const targetPath = validateTargetPath(
        canonicalScopeRoot,
        mutation.path,
      );
      await assertSafePath(canonicalScopeRoot, targetPath);
    }

    for (const mutation of plan.mutations) {
      await applyMutation(plan, canonicalScopeRoot, mutation, options);
    }

    applyCompleted = true;
  } catch (error) {
    if (error instanceof PapercutsError) {
      throw error;
    }

    throw new PapercutsError("setup_conflict");
  } finally {
    if (!applyCompleted) {
      await removeCreatedDirectories(createdScopeDirectories).catch(() => {
        throw new PapercutsError("setup_conflict");
      });
    }
  }
}

async function ensureCanonicalScopeRoot(
  scopeRoot: string,
  allowCreate: boolean,
): Promise<readonly string[]> {
  if (!isAbsolute(scopeRoot) || resolve(scopeRoot) !== scopeRoot) {
    throw new PapercutsError("setup_conflict");
  }

  const missingDirectories: string[] = [];
  let existingAncestor = scopeRoot;

  while (true) {
    try {
      const status = await lstat(existingAncestor);

      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new PapercutsError("setup_conflict");
      }

      if ((await realpath(existingAncestor)) !== existingAncestor) {
        throw new PapercutsError("setup_conflict");
      }

      break;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }

      if (!allowCreate) {
        throw new PapercutsError("setup_conflict");
      }

      const parent = dirname(existingAncestor);

      if (parent === existingAncestor) {
        throw new PapercutsError("setup_conflict");
      }

      missingDirectories.unshift(existingAncestor);
      existingAncestor = parent;
    }
  }

  if (missingDirectories.length > 1) {
    throw new PapercutsError("setup_conflict");
  }

  const created: string[] = [];

  try {
    for (const path of missingDirectories) {
      try {
        await mkdir(path, { mode: 0o700 });
        await chmod(path, 0o700);
        created.push(path);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }

      const status = await lstat(path);

      if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        (await realpath(path)) !== path
      ) {
        throw new PapercutsError("setup_conflict");
      }
    }

    return created;
  } catch (error) {
    await removeCreatedDirectories(created);
    throw error;
  }
}

async function applyMutation(
  plan: SetupPlan,
  canonicalScopeRoot: string,
  mutation: PlannedFileMutation,
  options: ApplySetupOptions,
): Promise<void> {
  const targetPath = validateTargetPath(canonicalScopeRoot, mutation.path);
  const lockPath = join(
    canonicalScopeRoot,
    `.papercuts-setup-${sha256Hex(targetPath).slice(0, 16)}.lock`,
  );
  const lockHandle = await acquireLock(canonicalScopeRoot, lockPath);

  try {
    await assertSafePath(canonicalScopeRoot, targetPath);
    const preimage = await readPreimage(canonicalScopeRoot, targetPath);
    verifyExpectedPreimage(preimage, mutation.expectedSha256);
    validateMutationSemantics(plan, mutation, preimage);

    if (mutation.nextContent === null) {
      await assertSafePath(canonicalScopeRoot, targetPath);
      const finalPreimage = await readPreimage(
        canonicalScopeRoot,
        targetPath,
      );
      verifyExpectedPreimage(finalPreimage, mutation.expectedSha256);
      validateEntirelyManagedFile(plan, finalPreimage);
      await unlink(targetPath);
      await syncDirectory(dirname(targetPath));
      return;
    }

    await replaceWithAtomicRename({
      canonicalScopeRoot,
      targetPath,
      mutation,
      preimage,
      options,
    });
  } finally {
    await lockHandle.close().catch(() => undefined);
    await unlink(lockPath).catch((error: unknown) => {
      if (!isMissingPathError(error)) {
        throw error;
      }
    });
  }
}

async function replaceWithAtomicRename(input: {
  canonicalScopeRoot: string;
  targetPath: string;
  mutation: PlannedFileMutation;
  preimage: Preimage;
  options: ApplySetupOptions;
}): Promise<void> {
  const parentPath = dirname(input.targetPath);
  const createdDirectories = await createPrivateParentDirectories(
    input.canonicalScopeRoot,
    parentPath,
  );
  let tempPath: string | undefined;
  let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
  let mutationCommitted = false;

  try {
    await assertSafePath(input.canonicalScopeRoot, input.targetPath);
    ({ path: tempPath, handle: tempHandle } = await createExclusiveTempFile(
      parentPath,
      input.targetPath,
    ));

    const targetMode = input.preimage.exists
      ? input.preimage.mode
      : input.mutation.createMode;
    await tempHandle.writeFile(
      new TextEncoder().encode(input.mutation.nextContent!),
    );
    await tempHandle.chmod(targetMode);
    await tempHandle.sync();

    await input.options.afterTempFileFlush?.({
      mutation: input.mutation,
      tempPath,
    });

    await assertSafePath(input.canonicalScopeRoot, input.targetPath);
    const finalPreimage = await readPreimage(
      input.canonicalScopeRoot,
      input.targetPath,
    );
    verifyExpectedPreimage(finalPreimage, input.mutation.expectedSha256);

    await tempHandle.close();
    tempHandle = undefined;

    // This is cooperative serialization plus a final preimage check. Portable
    // filesystem APIs cannot compare-and-swap against an unrelated editor in
    // the final instant between this check and rename.
    await rename(tempPath, input.targetPath);
    tempPath = undefined;
    mutationCommitted = true;
    await syncDirectory(parentPath);
  } finally {
    await tempHandle?.close().catch(() => undefined);

    if (tempPath !== undefined) {
      await unlink(tempPath).catch((error: unknown) => {
        if (!isMissingPathError(error)) {
          throw error;
        }
      });
    }

    if (!mutationCommitted) {
      await removeCreatedDirectories(createdDirectories);
    }
  }
}

async function validateCanonicalScopeRoot(scopeRoot: string): Promise<string> {
  if (!isAbsolute(scopeRoot) || resolve(scopeRoot) !== scopeRoot) {
    throw new PapercutsError("setup_conflict");
  }

  const status = await lstat(scopeRoot);

  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new PapercutsError("setup_conflict");
  }

  if ((await realpath(scopeRoot)) !== scopeRoot) {
    throw new PapercutsError("setup_conflict");
  }

  return scopeRoot;
}

function validateTargetPath(
  canonicalScopeRoot: string,
  targetPath: string,
): string {
  if (!isAbsolute(targetPath) || resolve(targetPath) !== targetPath) {
    throw new PapercutsError("setup_conflict");
  }

  const targetRelativeToScope = relative(canonicalScopeRoot, targetPath);

  if (
    targetRelativeToScope === "" ||
    targetRelativeToScope === ".." ||
    targetRelativeToScope.startsWith(`..${sep}`) ||
    isAbsolute(targetRelativeToScope)
  ) {
    throw new PapercutsError("setup_conflict");
  }

  return targetPath;
}

async function assertSafePath(
  canonicalScopeRoot: string,
  targetPath: string,
): Promise<void> {
  try {
    await assertPathHasNoSymlinkComponents(canonicalScopeRoot, targetPath);
  } catch {
    throw new PapercutsError("setup_conflict");
  }
}

async function readPreimage(
  canonicalScopeRoot: string,
  targetPath: string,
): Promise<Preimage> {
  await assertSafePath(canonicalScopeRoot, targetPath);

  let status;

  try {
    status = await lstat(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { exists: false, bytes: new Uint8Array(), mode: 0o600 };
    }

    throw new PapercutsError("setup_conflict");
  }

  if (!status.isFile() || status.isSymbolicLink()) {
    throw new PapercutsError("setup_conflict");
  }

  let handle;

  try {
    handle = await open(
      targetPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedStatus = await handle.stat();

    if (!openedStatus.isFile()) {
      throw new PapercutsError("setup_conflict");
    }

    return {
      exists: true,
      bytes: await handle.readFile(),
      mode: openedStatus.mode & 0o7777,
    };
  } catch (error) {
    if (error instanceof PapercutsError) {
      throw error;
    }

    throw new PapercutsError("setup_conflict");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function verifyExpectedPreimage(
  preimage: Preimage,
  expectedSha256: string | null,
): void {
  if (expectedSha256 === null) {
    if (preimage.exists) {
      throw new PapercutsError("setup_conflict");
    }

    return;
  }

  if (
    !/^[a-f0-9]{64}$/.test(expectedSha256) ||
    !preimage.exists ||
    sha256Hex(preimage.bytes) !== expectedSha256
  ) {
    throw new PapercutsError("setup_conflict");
  }
}

function validateMutationSemantics(
  plan: SetupPlan,
  mutation: PlannedFileMutation,
  preimage: Preimage,
): void {
  if (plan.action === "remove") {
    validateRemoveMutation(plan, mutation, preimage);
    return;
  }

  validateInstallMutation(plan, mutation, preimage);
}

function validateInstallMutation(
  plan: SetupPlan,
  mutation: PlannedFileMutation,
  preimage: Preimage,
): void {
  if (mutation.nextContent === null) {
    throw new PapercutsError("setup_conflict");
  }

  const current = decodeUtf8(preimage.bytes);
  const newline = detectNewline(current);
  const desiredBlock = desiredInstructions(plan, newline);
  let expectedNext: string;

  if (!preimage.exists || current.length === 0) {
    expectedNext = desiredBlock;
  } else {
    const parsed = parseManagedBlock(current);

    if (parsed.kind === "absent") {
      if (plan.harness === "claude-code") {
        throw new PapercutsError("setup_conflict");
      }

      expectedNext = `${current}${newline}${newline}${desiredBlock}`;
    } else {
      validateExistingManagedBlock(plan, current, parsed, desiredBlock);
      expectedNext =
        current.slice(0, parsed.start) +
        desiredBlock +
        current.slice(parsed.end);
    }
  }

  if (mutation.nextContent !== expectedNext) {
    throw new PapercutsError("setup_conflict");
  }
}

function validateRemoveMutation(
  plan: SetupPlan,
  mutation: PlannedFileMutation,
  preimage: Preimage,
): void {
  if (!preimage.exists) {
    throw new PapercutsError("setup_conflict");
  }

  const current = decodeUtf8(preimage.bytes);
  const newline = detectNewline(current);
  const desiredBlock = desiredInstructions(plan, newline);
  const parsed = parseManagedBlock(current);

  if (parsed.kind === "absent") {
    throw new PapercutsError("setup_conflict");
  }

  validateExistingManagedBlock(plan, current, parsed, desiredBlock);
  const entirelyManaged = parsed.start === 0 && parsed.end === current.length;
  const expectedNext =
    plan.harness === "claude-code" || entirelyManaged
      ? null
      : removeManagedBlock(current, parsed.start, parsed.end, newline);

  if (mutation.nextContent !== expectedNext) {
    throw new PapercutsError("setup_conflict");
  }
}

function validateExistingManagedBlock(
  plan: SetupPlan,
  current: string,
  parsed: Extract<ReturnType<typeof parseManagedBlock>, { kind: "present" }>,
  desiredBlock: string,
): void {
  const existingBlock = current.slice(parsed.start, parsed.end);

  if (parsed.version === "1" && existingBlock !== desiredBlock) {
    throw new PapercutsError("setup_conflict");
  }

  if (
    plan.harness === "claude-code" &&
    (parsed.start !== 0 || parsed.end !== current.length)
  ) {
    throw new PapercutsError("setup_conflict");
  }
}

function validateEntirelyManagedFile(
  plan: SetupPlan,
  preimage: Preimage,
): void {
  if (!preimage.exists) {
    throw new PapercutsError("setup_conflict");
  }

  const content = decodeUtf8(preimage.bytes);
  const newline = detectNewline(content);
  const parsed = parseManagedBlock(content);

  if (
    parsed.kind !== "present" ||
    parsed.start !== 0 ||
    parsed.end !== content.length
  ) {
    throw new PapercutsError("setup_conflict");
  }

  validateExistingManagedBlock(
    plan,
    content,
    parsed,
    desiredInstructions(plan, newline),
  );
}

function desiredInstructions(plan: SetupPlan, newline: Newline): string {
  const content =
    plan.harness === "codex"
      ? renderCodexInstructions()
      : renderClaudeInstructions();
  return content.replaceAll("\n", newline);
}

function removeManagedBlock(
  content: string,
  start: number,
  end: number,
  newline: Newline,
): string {
  const separator = `${newline}${newline}`;
  const prefixStart =
    start >= separator.length &&
    content.slice(start - separator.length, start) === separator
      ? start - separator.length
      : start;
  return content.slice(0, prefixStart) + content.slice(end);
}

async function createPrivateParentDirectories(
  canonicalScopeRoot: string,
  parentPath: string,
): Promise<readonly string[]> {
  validateTargetPath(canonicalScopeRoot, join(parentPath, ".papercuts-child"));
  const relativeParent = relative(canonicalScopeRoot, parentPath);
  const components = relativeParent === "" ? [] : relativeParent.split(sep);
  const created: string[] = [];
  let current = canonicalScopeRoot;

  try {
    for (const component of components) {
      current = join(current, component);

      try {
        const status = await lstat(current);

        if (!status.isDirectory() || status.isSymbolicLink()) {
          throw new PapercutsError("setup_conflict");
        }
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }

        try {
          await mkdir(current, { mode: 0o700 });
          await chmod(current, 0o700);
          created.push(current);
        } catch (mkdirError) {
          if (!isAlreadyExistsError(mkdirError)) {
            throw mkdirError;
          }

          const status = await lstat(current);

          if (!status.isDirectory() || status.isSymbolicLink()) {
            throw new PapercutsError("setup_conflict");
          }
        }
      }
    }

    return created;
  } catch (error) {
    await removeCreatedDirectories(created);
    throw error;
  }
}

async function removeCreatedDirectories(
  createdDirectories: readonly string[],
): Promise<void> {
  for (const path of [...createdDirectories].reverse()) {
    await rmdir(path).catch((error: unknown) => {
      if (!isMissingPathError(error) && !isDirectoryNotEmptyError(error)) {
        throw error;
      }
    });
  }
}

async function createExclusiveTempFile(
  parentPath: string,
  targetPath: string,
): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>> }> {
  const targetHash = sha256Hex(targetPath).slice(0, 16);

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const path = join(
      parentPath,
      `.papercuts-tmp-${targetHash}-${randomUUID()}.tmp`,
    );

    try {
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      return { path, handle };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  throw new PapercutsError("setup_conflict");
}

async function acquireLock(
  canonicalScopeRoot: string,
  lockPath: string,
): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    await validateCanonicalScopeRoot(canonicalScopeRoot);

    try {
      return await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw new PapercutsError("setup_conflict");
      }

      await delay(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new PapercutsError("setup_conflict");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PapercutsError("setup_conflict");
  }
}

function detectNewline(content: string): Newline {
  const match = content.match(/\r\n|\r|\n/);
  return (match?.[0] as Newline | undefined) ?? "\n";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isMissingPathError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isAlreadyExistsError(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

function isDirectoryNotEmptyError(error: unknown): boolean {
  return hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EEXIST");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
