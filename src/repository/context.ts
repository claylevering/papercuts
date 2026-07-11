import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";

import { PapercutsError } from "../domain/errors";
import type {
  RedactionResult,
  RepoContext,
  ResolvedRepoContext,
} from "../domain/types";
import { sha256Hex } from "../platform/hash";
import {
  bunProcessRunner,
  type ProcessResult,
  type ProcessRunner,
} from "../platform/process";
import { redact } from "../security/redactor";
import { normalizeRemote } from "./remote";

export async function resolveRepoContext(
  cwd: string,
): Promise<ResolvedRepoContext | null> {
  try {
    return await discoverRepoContext(cwd, bunProcessRunner);
  } catch (error) {
    if (error instanceof PapercutsError) {
      throw error;
    }

    throw new PapercutsError("internal_error");
  }
}

async function discoverRepoContext(
  cwd: string,
  processRunner: ProcessRunner,
): Promise<ResolvedRepoContext | null> {
  const rootResult = await runGit(processRunner, cwd, [
    "rev-parse",
    "--show-toplevel",
  ]);

  if (rootResult.exitCode !== 0) {
    return null;
  }

  const root = await realpath(singleLine(rootResult.stdout));
  const realCwd = await realpath(cwd);
  const commonDirectoryResult = await runGit(processRunner, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);

  if (commonDirectoryResult.exitCode !== 0) {
    throw new PapercutsError("internal_error");
  }

  const commonDirectory = await realpath(singleLine(commonDirectoryResult.stdout));
  const commonMetadata = await stat(commonDirectory, { bigint: true });
  const localKey = sha256Hex(
    `local:${commonMetadata.dev}:${commonMetadata.ino}`,
  );
  const cwdRelative = normalizeRelativePath(root, realCwd);
  const remote = await resolveSelectedRemote(processRunner, cwd);
  const normalizedRemote = remote === null ? null : normalizeRemote(remote);

  let key = localKey;
  let keyKind: RepoContext["keyKind"] = "local";
  let displayCandidate = basename(root);
  let redactionCount = 0;

  if (normalizedRemote !== null) {
    const screenedRemote = screen(normalizedRemote);
    redactionCount += screenedRemote.replacementCount;
    displayCandidate = basename(String(screenedRemote.text));

    if (screenedRemote.replacementCount === 0) {
      key = sha256Hex(`remote:${screenedRemote.text}`);
      keyKind = "remote";
    }
  }

  const branch = await resolveBranch(processRunner, cwd);
  const head = await resolveHead(processRunner, cwd);
  const screenedDisplayName = screen(displayCandidate);
  const screenedRoot = screen(root);
  const screenedCwdRelative = screen(cwdRelative);
  const screenedBranch = branch === null ? null : screen(branch);
  const screenedHead = head === null ? null : screen(head);

  redactionCount +=
    screenedDisplayName.replacementCount +
    screenedRoot.replacementCount +
    screenedCwdRelative.replacementCount +
    (screenedBranch?.replacementCount ?? 0) +
    (screenedHead?.replacementCount ?? 0);

  return {
    context: {
      key,
      keyKind,
      displayName: screenedDisplayName.text,
      root: screenedRoot.text,
      cwdRelative: screenedCwdRelative.text,
      branch: screenedBranch?.text ?? null,
      head: screenedHead?.text ?? null,
    },
    redactionCount,
  };
}

async function resolveSelectedRemote(
  processRunner: ProcessRunner,
  cwd: string,
): Promise<string | null> {
  const remotesResult = await runGit(processRunner, cwd, ["remote"]);

  if (remotesResult.exitCode !== 0) {
    throw new PapercutsError("internal_error");
  }

  const remotes = remotesResult.stdout
    .split(/\r?\n/)
    .map((remote) => remote.trim())
    .filter((remote) => remote.length > 0);
  const selected = remotes.includes("origin")
    ? "origin"
    : remotes.length === 1
      ? remotes[0]
      : undefined;

  if (selected === undefined) {
    return null;
  }

  const remoteResult = await runGit(processRunner, cwd, [
    "remote",
    "get-url",
    "--",
    selected,
  ]);

  return remoteResult.exitCode === 0 ? singleLine(remoteResult.stdout) : null;
}

async function resolveBranch(
  processRunner: ProcessRunner,
  cwd: string,
): Promise<string | null> {
  const result = await runGit(processRunner, cwd, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);

  return result.exitCode === 0 ? singleLine(result.stdout) : null;
}

async function resolveHead(
  processRunner: ProcessRunner,
  cwd: string,
): Promise<string | null> {
  const result = await runGit(processRunner, cwd, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);

  return result.exitCode === 0 ? singleLine(result.stdout) : null;
}

function normalizeRelativePath(root: string, cwd: string): string {
  const path = relative(root, cwd);

  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new PapercutsError("internal_error");
  }

  return path.length === 0 ? "." : path.replaceAll("\\", "/");
}

function screen(raw: string): RedactionResult {
  try {
    return redact(raw);
  } catch {
    throw new PapercutsError("safety_failure");
  }
}

function singleLine(stdout: string): string {
  return stdout.replace(/[\r\n]+$/, "");
}

function runGit(
  processRunner: ProcessRunner,
  cwd: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return processRunner.run("git", args, cwd);
}
