import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { PapercutsError } from "../domain/errors";
import { sha256Hex } from "../platform/hash";
import { assertPathHasNoSymlinkComponents } from "../platform/private-files";
import {
  renderClaudeInstructions,
  renderCodexInstructions,
  renderGenericInstructions,
} from "./content";
import { parseManagedBlock } from "./markers";
import type {
  PlannedFileMutation,
  SetupPlan,
  SetupRequest,
} from "./types";

type Newline = "\n" | "\r\n" | "\r";

type TargetSnapshot =
  | { kind: "missing" }
  | { kind: "unsafe" }
  | { kind: "file"; bytes: Uint8Array; content: string };

export async function planSetup(request: SetupRequest): Promise<SetupPlan> {
  try {
    const canonicalScopeRoot = await resolveScopeRoot(request);

    if (request.harness === "generic") {
      return {
        harness: request.harness,
        action: request.action,
        scope: request.scope,
        canonicalScopeRoot,
        state: "absent",
        mutations: [],
        snippet: renderGenericInstructions(),
      };
    }

    const targetPath =
      request.harness === "codex"
        ? await resolveCodexTarget(canonicalScopeRoot)
        : resolveClaudeTarget(canonicalScopeRoot);
    const snapshot = await readTarget(canonicalScopeRoot, targetPath);

    if (snapshot.kind === "unsafe") {
      return conflictPlan(request, canonicalScopeRoot);
    }

    const instructions =
      request.harness === "codex"
        ? renderCodexInstructions()
        : renderClaudeInstructions();

    return buildFilePlan({
      request,
      canonicalScopeRoot,
      targetPath,
      snapshot,
      instructions,
      adapterOwnedFile: request.harness === "claude-code",
    });
  } catch (error) {
    if (error instanceof PapercutsError) {
      throw error;
    }

    throw new PapercutsError("setup_conflict");
  }
}

async function resolveScopeRoot(request: SetupRequest): Promise<string> {
  let scopeRoot: string;

  if (request.scope.kind === "repo") {
    scopeRoot = request.scope.root;
  } else if (request.harness === "codex") {
    scopeRoot = request.codexHome ?? join(request.home, ".codex");
  } else {
    scopeRoot = request.home;
  }

  if (!isAbsolute(scopeRoot)) {
    throw new PapercutsError("setup_conflict");
  }

  const absoluteRoot = resolve(scopeRoot);
  const missingComponents: string[] = [];
  let existingAncestor = absoluteRoot;

  while (true) {
    try {
      return join(await realpath(existingAncestor), ...missingComponents);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new PapercutsError("setup_conflict");
      }

      const parent = dirname(existingAncestor);

      if (parent === existingAncestor) {
        throw new PapercutsError("setup_conflict");
      }

      missingComponents.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

async function resolveCodexTarget(canonicalScopeRoot: string): Promise<string> {
  const overridePath = join(canonicalScopeRoot, "AGENTS.override.md");
  const override = await readTarget(canonicalScopeRoot, overridePath);

  if (override.kind === "unsafe") {
    return overridePath;
  }

  if (override.kind === "file" && override.content.trim().length > 0) {
    return overridePath;
  }

  return join(canonicalScopeRoot, "AGENTS.md");
}

function resolveClaudeTarget(canonicalScopeRoot: string): string {
  return join(canonicalScopeRoot, ".claude", "rules", "papercuts.md");
}

async function readTarget(
  canonicalScopeRoot: string,
  targetPath: string,
): Promise<TargetSnapshot> {
  try {
    await assertPathHasNoSymlinkComponents(canonicalScopeRoot, targetPath);
    const status = await lstat(targetPath);

    if (!status.isFile() || status.isSymbolicLink()) {
      return { kind: "unsafe" };
    }

    const handle = await open(
      targetPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );

    try {
      const openedStatus = await handle.stat();

      if (!openedStatus.isFile()) {
        return { kind: "unsafe" };
      }

      const bytes = await handle.readFile();
      let content: string;

      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { kind: "unsafe" };
      }

      return { kind: "file", bytes, content };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return { kind: "missing" };
    }

    return { kind: "unsafe" };
  }
}

function buildFilePlan(input: {
  request: SetupRequest;
  canonicalScopeRoot: string;
  targetPath: string;
  snapshot: Exclude<TargetSnapshot, { kind: "unsafe" }>;
  instructions: string;
  adapterOwnedFile: boolean;
}): SetupPlan {
  const { request, canonicalScopeRoot, targetPath, snapshot } = input;
  const content = snapshot.kind === "file" ? snapshot.content : "";
  const newline = detectNewline(content);
  const desiredBlock = useNewline(input.instructions, newline);
  const expectedSha256 =
    snapshot.kind === "file" ? sha256Hex(snapshot.bytes) : null;
  let parsed;

  try {
    parsed = parseManagedBlock(content);
  } catch {
    return conflictPlan(request, canonicalScopeRoot);
  }

  if (parsed.kind === "absent") {
    if (input.adapterOwnedFile && snapshot.kind === "file") {
      return conflictPlan(request, canonicalScopeRoot);
    }

    if (request.action === "remove") {
      return basePlan(request, canonicalScopeRoot, "absent", []);
    }

    const nextContent = input.adapterOwnedFile
      ? desiredBlock
      : appendManagedBlock(content, desiredBlock, newline);

    return basePlan(request, canonicalScopeRoot, "absent", [
      mutation(
        targetPath,
        expectedSha256,
        nextContent,
        request.action,
        desiredBlock,
      ),
    ]);
  }

  const currentBlock = content.slice(parsed.start, parsed.end);
  const blockIsCurrent = currentBlock === desiredBlock;
  const fileIsEntirelyManaged =
    parsed.start === 0 && parsed.end === content.length;

  if (parsed.version === "1" && !blockIsCurrent) {
    return conflictPlan(request, canonicalScopeRoot);
  }

  if (input.adapterOwnedFile && !fileIsEntirelyManaged) {
    return conflictPlan(request, canonicalScopeRoot);
  }

  const state = parsed.version === "1" ? "current" : "outdated";

  if (request.action === "install") {
    if (blockIsCurrent) {
      return basePlan(request, canonicalScopeRoot, "current", []);
    }

    const nextContent =
      content.slice(0, parsed.start) +
      desiredBlock +
      content.slice(parsed.end);
    return basePlan(request, canonicalScopeRoot, state, [
      mutation(
        targetPath,
        expectedSha256,
        nextContent,
        request.action,
        desiredBlock,
      ),
    ]);
  }

  const nextContent =
    input.adapterOwnedFile || fileIsEntirelyManaged
      ? null
      : removeManagedBlock(content, parsed.start, parsed.end, newline);

  return basePlan(request, canonicalScopeRoot, state, [
    mutation(
      targetPath,
      expectedSha256,
      nextContent,
      request.action,
      desiredBlock,
    ),
  ]);
}

function appendManagedBlock(
  content: string,
  managedBlock: string,
  newline: Newline,
): string {
  if (content.length === 0) {
    return managedBlock;
  }

  return `${content}${newline}${newline}${managedBlock}`;
}

function removeManagedBlock(
  content: string,
  start: number,
  end: number,
  newline: Newline,
): string {
  const managedSeparator = `${newline}${newline}`;
  const prefixStart =
    start >= managedSeparator.length &&
    content.slice(start - managedSeparator.length, start) === managedSeparator
      ? start - managedSeparator.length
      : start;

  return content.slice(0, prefixStart) + content.slice(end);
}

function mutation(
  path: string,
  expectedSha256: string | null,
  nextContent: string | null,
  action: "install" | "remove",
  managedBlock: string,
): PlannedFileMutation {
  const prefix = action === "install" ? "+" : "-";

  return {
    path,
    expectedSha256,
    nextContent,
    createMode: 0o600,
    managedDiff: [
      `${action} ${basename(path)}`,
      ...managedBlock.split(/\r\n|\r|\n/).map((line) => `${prefix} ${line}`),
    ],
  };
}

function basePlan(
  request: SetupRequest,
  canonicalScopeRoot: string,
  state: SetupPlan["state"],
  mutations: readonly PlannedFileMutation[],
): SetupPlan {
  return {
    harness: request.harness,
    action: request.action,
    scope: request.scope,
    canonicalScopeRoot,
    state,
    mutations,
  };
}

function conflictPlan(
  request: SetupRequest,
  canonicalScopeRoot: string,
): SetupPlan {
  return basePlan(request, canonicalScopeRoot, "conflict", []);
}

function detectNewline(content: string): Newline {
  const match = content.match(/\r\n|\r|\n/);
  return (match?.[0] as Newline | undefined) ?? "\n";
}

function useNewline(content: string, newline: Newline): string {
  return content.replaceAll("\n", newline);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export type {
  Harness,
  PlannedFileMutation,
  SetupPlan,
  SetupRequest,
  SetupScope,
} from "./types";
