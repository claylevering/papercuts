import { randomUUID as temporaryNameUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { resolve } from "node:path";

import { createCaptureService, type CaptureInput } from "../capture/service";
import { PapercutsError } from "../domain/errors";
import type {
  Papercut,
  PapercutQuery,
  PapercutStore,
  ResolvedRepoContext,
} from "../domain/types";
import { defaultStatPath, runDoctor } from "../doctor/checks";
import { resolvePapercutsPaths } from "../platform/paths";
import type { SetupPlan, SetupRequest, SetupScope } from "../setup/types";
import { renderList, renderStats, type ScopeDescriptor } from "../views/human";
import { renderMarkdown } from "../views/markdown";
import { summarize } from "../views/stats";
import { parseArgs, type ParsedCommand } from "./args";
import { readBoundedStdin } from "./input";
import {
  exitCodeForError,
  writeHumanError,
  writeJsonError,
  writeJsonSuccess,
} from "./output";

/** Process I/O injected into the CLI so tests never touch real streams. */
export interface CliIo {
  stdin: AsyncIterable<Uint8Array>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  stdoutIsTty: boolean;
}

/** Ambient values resolved once by the entrypoint, never read from `.env`. */
export interface CliEnvironment {
  cwd: string;
  home: string;
  papercutsHome?: string;
  codexHome?: string;
  pathValue?: string;
}

/**
 * Every external capability the CLI orchestrates, injected so command routing
 * stays observable. The store factory is invoked lazily: help, version, and
 * setup previews — and every expected pre-store validation failure — must
 * complete without it ever being called.
 */
export interface CliRuntime {
  io: CliIo;
  environment: CliEnvironment;
  openStore(path: string): PapercutStore;
  resolveRepoContext(cwd: string): Promise<ResolvedRepoContext | null>;
  planSetup(request: SetupRequest): Promise<SetupPlan>;
  applySetup(plan: SetupPlan): Promise<void>;
  now(): number;
  randomUUID(): string;
  clientVersion: string;
  runtimeVersion: string;
}

type AddCommand = Extract<ParsedCommand, { kind: "add" }>;
type ListCommand = Extract<ParsedCommand, { kind: "list" }>;
type StatsCommand = Extract<ParsedCommand, { kind: "stats" }>;
type ExportCommand = Extract<ParsedCommand, { kind: "export" }>;
type SetupCommand = Extract<ParsedCommand, { kind: "setup" }>;

const MAX_STDIN_BYTES = 65_536;

const GENERAL_USAGE = [
  "Usage: papercuts <command> [options]",
  "",
  "Commands:",
  "  add TEXT | add --stdin  Record a papercut",
  "  list                    List recorded papercuts",
  "  stats                   Show papercut statistics",
  "  export                  Export papercuts as Markdown",
  "  setup                   Preview or install harness guidance",
  "  doctor                  Run environment diagnostics",
  "",
  "Global options:",
  "  --json     Emit exactly one versioned JSON object",
  "  --help     Show help for the CLI or a command",
  "  --version  Show the CLI version",
].join("\n");

const COMMAND_USAGE: Readonly<Record<string, string>> = Object.freeze({
  add: "papercuts add TEXT | papercuts add --stdin [--source codex|claude-code|generic|manual] [--model MODEL] [--category CATEGORY] [--tag TAG ...]",
  list: "papercuts list [--repo current|all] [--since DURATION] [--limit N]",
  stats: "papercuts stats [--repo current|all] [--since DURATION]",
  export:
    "papercuts export [--repo current|all] [--since DURATION] [--output FILE] [--force]",
  setup:
    "papercuts setup codex|claude-code|generic [--scope user|repo] [--undo] [--apply]",
  doctor: "papercuts doctor",
});

/**
 * Parse and execute one CLI invocation, returning the process exit code.
 * Handled failures never throw: JSON mode writes one failure envelope to
 * stdout (stderr stays empty), human mode writes one sanitized line to stderr.
 */
export async function runCli(
  argv: readonly string[],
  runtime: CliRuntime,
): Promise<number> {
  const json = argv.includes("--json");
  let command = fallbackCommandName(argv);

  try {
    const parsed = parseArgs(argv);
    command = parsed.kind;

    switch (parsed.kind) {
      case "help":
        return runHelp(parsed.topic, parsed.json, runtime);
      case "version":
        return runVersion(parsed.json, runtime);
      case "add":
        return await runAdd(parsed, runtime);
      case "list":
        return await runList(parsed, runtime);
      case "stats":
        return await runStats(parsed, runtime);
      case "export":
        return await runExport(parsed, runtime);
      case "setup":
        return await runSetup(parsed, runtime);
      case "doctor":
        return await runDoctorCommand(parsed.json, runtime);
    }
  } catch (error) {
    if (json) {
      writeJsonError(runtime.io, command, error);
    } else {
      writeHumanError(runtime.io, error);
    }
    return exitCodeForError(error);
  }
}

/**
 * Pick a fixed envelope command name for failures that occur before parsing
 * succeeds. Only known command words are ever echoed; anything else falls back
 * to a constant so no user-controlled token reaches the output.
 */
function fallbackCommandName(argv: readonly string[]): string {
  for (const token of argv) {
    if (Object.hasOwn(COMMAND_USAGE, token)) {
      return token;
    }
  }
  return argv.includes("--version") ? "version" : "help";
}

function runHelp(
  topic: string | undefined,
  json: boolean,
  runtime: CliRuntime,
): number {
  const usage =
    topic === undefined ? GENERAL_USAGE : (COMMAND_USAGE[topic] ?? GENERAL_USAGE);

  if (json) {
    writeJsonSuccess(runtime.io, "help", { topic: topic ?? null, usage });
  } else {
    runtime.io.writeStdout(`${usage}\n`);
  }
  return 0;
}

function runVersion(json: boolean, runtime: CliRuntime): number {
  if (json) {
    writeJsonSuccess(runtime.io, "version", { version: runtime.clientVersion });
  } else {
    runtime.io.writeStdout(`${runtime.clientVersion}\n`);
  }
  return 0;
}

async function runAdd(parsed: AddCommand, runtime: CliRuntime): Promise<number> {
  const body = parsed.stdin
    ? await readBoundedStdin(runtime.io.stdin, MAX_STDIN_BYTES)
    : (parsed.text ?? "");

  // An empty submission must fail before the store is ever opened.
  if (body.length === 0) {
    throw new PapercutsError("invalid_input");
  }

  const store = openDataStore(runtime);

  try {
    const service = createCaptureService({
      store,
      resolveRepoContext: runtime.resolveRepoContext,
      now: runtime.now,
      randomUUID: runtime.randomUUID,
      clientVersion: runtime.clientVersion,
    });
    const input: CaptureInput = {
      body,
      source: parsed.source,
      tags: parsed.tags,
      cwd: runtime.environment.cwd,
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      ...(parsed.category !== undefined ? { category: parsed.category } : {}),
    };
    const { receipt, warnings } = await service.capture(input);
    const data = {
      id: receipt.id,
      createdAt: toRfc3339Utc(receipt.createdAtMs),
      source: receipt.source,
      repository:
        receipt.repository === null ? null : { name: receipt.repository.name },
      redactionCount: receipt.redactionCount,
    };

    if (parsed.json) {
      writeJsonSuccess(runtime.io, "add", data, warnings);
    } else {
      const lines = [
        `Recorded papercut ${receipt.id}.`,
        `Created: ${data.createdAt}`,
        `Source: ${receipt.source}`,
      ];
      if (receipt.repository !== null) {
        lines.push(`Repository: ${receipt.repository.name}`);
      }
      lines.push(`Redactions: ${receipt.redactionCount}`);
      runtime.io.writeStdout(`${lines.join("\n")}\n`);
      for (const warning of warnings) {
        runtime.io.writeStderr(`${warning}\n`);
      }
    }
    return 0;
  } finally {
    closeQuietly(store);
  }
}

async function runList(parsed: ListCommand, runtime: CliRuntime): Promise<number> {
  const resolved = await resolveReadScope(parsed.repo, runtime);
  const records = await withStore(runtime, (store) =>
    store.list(
      buildQuery(resolved.repoKey, parsed.sinceMs, parsed.limit, "newest", runtime),
    ),
  );

  if (parsed.json) {
    writeJsonSuccess(runtime.io, "list", {
      scope: resolved.scope,
      records: records.map(toRecordPayload),
    });
  } else {
    runtime.io.writeStdout(renderList(records, resolved.scope));
  }
  return 0;
}

async function runStats(parsed: StatsCommand, runtime: CliRuntime): Promise<number> {
  const resolved = await resolveReadScope(parsed.repo, runtime);
  const records = await withStore(runtime, (store) =>
    store.list(
      buildQuery(resolved.repoKey, parsed.sinceMs, undefined, "oldest", runtime),
    ),
  );
  const summary = summarize(records);

  if (parsed.json) {
    writeJsonSuccess(runtime.io, "stats", { scope: resolved.scope, ...summary });
  } else {
    runtime.io.writeStdout(renderStats(summary, resolved.scope));
  }
  return 0;
}

async function runExport(parsed: ExportCommand, runtime: CliRuntime): Promise<number> {
  const resolved = await resolveReadScope(parsed.repo, runtime);
  const records = await withStore(runtime, (store) =>
    store.list(
      buildQuery(resolved.repoKey, parsed.sinceMs, undefined, "oldest", runtime),
    ),
  );
  const markdown = renderMarkdown(records, resolved.scope);

  if (parsed.output === undefined) {
    if (parsed.json) {
      writeJsonSuccess(runtime.io, "export", {
        scope: resolved.scope,
        recordCount: records.length,
        outputPath: null,
        markdown,
      });
    } else {
      runtime.io.writeStdout(markdown);
    }
    return 0;
  }

  const outputPath = resolve(runtime.environment.cwd, parsed.output);
  writeExportFile(outputPath, markdown, parsed.force);

  if (parsed.json) {
    writeJsonSuccess(runtime.io, "export", {
      scope: resolved.scope,
      recordCount: records.length,
      outputPath,
      markdown: null,
    });
  } else {
    runtime.io.writeStdout(
      `Exported ${records.length} papercut(s) — ${describeScope(resolved.scope)}.\n`,
    );
  }
  return 0;
}

async function runSetup(parsed: SetupCommand, runtime: CliRuntime): Promise<number> {
  // Generic has no safe apply target; refuse before planning touches anything.
  if (parsed.harness === "generic" && parsed.apply) {
    throw new PapercutsError("setup_conflict");
  }

  const scope = await resolveSetupScope(parsed.scope, runtime);
  const request: SetupRequest = {
    harness: parsed.harness,
    action: parsed.undo ? "remove" : "install",
    scope,
    home: runtime.environment.home,
    ...(runtime.environment.codexHome !== undefined
      ? { codexHome: runtime.environment.codexHome }
      : {}),
  };
  const plan = await runtime.planSetup(request);

  if (parsed.apply) {
    if (plan.state === "conflict") {
      throw new PapercutsError("setup_conflict");
    }
    await runtime.applySetup(plan);
  }

  const data = {
    harness: plan.harness,
    action: plan.action,
    scope: parsed.scope,
    state: plan.state,
    mutations: plan.mutations.map((mutation) => ({
      path: mutation.path,
      managedDiff: mutation.managedDiff,
    })),
    snippet: plan.snippet ?? null,
  };

  if (parsed.json) {
    writeJsonSuccess(runtime.io, "setup", data);
  } else {
    const lines = [
      `Setup ${plan.harness} (${parsed.scope} scope): ${plan.action}`,
      `State: ${plan.state}`,
    ];
    for (const mutation of data.mutations) {
      lines.push(`Target: ${mutation.path}`);
      for (const diffLine of mutation.managedDiff) {
        lines.push(`  ${diffLine}`);
      }
    }
    if (data.snippet !== null) {
      lines.push("", data.snippet);
    }
    if (parsed.apply) {
      lines.push("Applied.");
    } else if (data.mutations.length > 0) {
      lines.push("Preview only. Re-run with --apply to write changes.");
    }
    runtime.io.writeStdout(`${lines.join("\n")}\n`);
  }
  return 0;
}

async function runDoctorCommand(json: boolean, runtime: CliRuntime): Promise<number> {
  const report = await runDoctor({
    clientVersion: runtime.clientVersion,
    runtimeVersion: runtime.runtimeVersion,
    currentUid: typeof process.getuid === "function" ? process.getuid() : 0,
    environment: runtime.environment,
    statPath: defaultStatPath,
    openStore: runtime.openStore,
    resolveRepoContext: runtime.resolveRepoContext,
    planSetup: runtime.planSetup,
  });

  if (json) {
    writeJsonSuccess(runtime.io, "doctor", report);
  } else {
    const lines = report.checks.map(
      (check) => `[${check.status}] ${check.name}: ${check.message}`,
    );
    lines.push(report.ok ? "Doctor: ok" : "Doctor: problems found");
    runtime.io.writeStdout(`${lines.join("\n")}\n`);
  }
  return report.ok ? 0 : 1;
}

/**
 * Resolve the effective read scope for list/stats/export. `auto` follows the
 * working directory: current repository inside Git, everything outside. An
 * explicit `current` outside Git is a validation error, and an explicit `all`
 * never touches Git at all.
 */
async function resolveReadScope(
  repo: "auto" | "current" | "all",
  runtime: CliRuntime,
): Promise<{ scope: ScopeDescriptor; repoKey?: string }> {
  if (repo === "all") {
    return { scope: { kind: "all" } };
  }

  const resolved = await runtime.resolveRepoContext(runtime.environment.cwd);

  if (resolved === null) {
    if (repo === "current") {
      throw new PapercutsError("invalid_input");
    }
    return { scope: { kind: "all" } };
  }

  return {
    scope: {
      kind: "current",
      repository: { name: resolved.context.displayName },
    },
    repoKey: resolved.context.key,
  };
}

async function resolveSetupScope(
  scope: "user" | "repo",
  runtime: CliRuntime,
): Promise<SetupScope> {
  if (scope === "user") {
    return { kind: "user" };
  }

  const resolved = await runtime.resolveRepoContext(runtime.environment.cwd);

  if (resolved === null) {
    throw new PapercutsError("invalid_input");
  }

  // The screened root is byte-identical to the real worktree root unless
  // redaction replaced something, in which case the path cannot exist and the
  // setup adapters fail closed with a conflict.
  return { kind: "repo", root: resolved.context.root };
}

function buildQuery(
  repoKey: string | undefined,
  sinceWindowMs: number | undefined,
  limit: number | undefined,
  order: PapercutQuery["order"],
  runtime: CliRuntime,
): PapercutQuery {
  const query: PapercutQuery = { order };

  if (repoKey !== undefined) {
    query.repoKey = repoKey;
  }
  if (sinceWindowMs !== undefined) {
    query.sinceMs = runtime.now() - sinceWindowMs;
  }
  if (limit !== undefined) {
    query.limit = limit;
  }
  return query;
}

function toRecordPayload(record: Papercut): Record<string, unknown> {
  return {
    id: record.id,
    createdAt: toRfc3339Utc(record.createdAtMs),
    body: record.body,
    source: record.source,
    model: record.model,
    category: record.category,
    tags: record.tags,
    repository:
      record.repo === null
        ? null
        : {
            name: record.repo.displayName,
            branch: record.repo.branch,
            cwdRelative: record.repo.cwdRelative,
          },
    redactionCount: record.redactionCount,
  };
}

function describeScope(scope: ScopeDescriptor): string {
  return scope.kind === "all"
    ? "all repositories"
    : `current repository ${scope.repository.name}`;
}

function toRfc3339Utc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function openDataStore(runtime: CliRuntime): PapercutStore {
  const environment = runtime.environment;
  let databasePath: string;

  try {
    ({ databasePath } = resolvePapercutsPaths(
      environment.papercutsHome === undefined
        ? { home: environment.home }
        : { home: environment.home, papercutsHome: environment.papercutsHome },
    ));
  } catch {
    throw new PapercutsError("invalid_input");
  }

  return runtime.openStore(databasePath);
}

async function withStore<T>(
  runtime: CliRuntime,
  read: (store: PapercutStore) => T,
): Promise<T> {
  const store = openDataStore(runtime);

  try {
    return read(store);
  } finally {
    closeQuietly(store);
  }
}

function closeQuietly(store: PapercutStore): void {
  try {
    store.close();
  } catch {
    // Preserve the primary outcome; close diagnostics are never surfaced.
  }
}

/**
 * Write the export document to `path`. Without `--force` the file is created
 * with an exclusive open so an existing path is refused atomically; with
 * `--force` the content lands in a same-directory temporary file and replaces
 * the target via atomic rename.
 */
function writeExportFile(path: string, content: string, force: boolean): void {
  if (!force) {
    writeToNewFile(path, content);
    return;
  }

  const temporaryPath = `${path}.${temporaryNameUUID()}.tmp`;
  writeToNewFile(temporaryPath, content);

  try {
    renameSync(temporaryPath, path);
  } catch {
    unlinkQuietly(temporaryPath);
    throw new PapercutsError("internal_error");
  }
}

function writeToNewFile(path: string, content: string): void {
  let descriptor: number;

  try {
    descriptor = openSync(path, "wx");
  } catch {
    // An existing target (or an unusable output path) is a validation error.
    throw new PapercutsError("invalid_input");
  }

  try {
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;

    while (offset < bytes.byteLength) {
      offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    }
    fsyncSync(descriptor);
  } catch {
    closeQuietlyDescriptor(descriptor);
    unlinkQuietly(path);
    throw new PapercutsError("internal_error");
  }

  closeQuietlyDescriptor(descriptor);
}

function closeQuietlyDescriptor(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Never mask the primary outcome with a close failure.
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Cleanup is best-effort; the primary error already carries the outcome.
  }
}
