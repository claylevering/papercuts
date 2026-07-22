import { PapercutsError } from "../domain/errors";
import type { CaptureSource } from "../domain/types";
import type { Harness } from "../setup/types";

/**
 * The fully parsed command surface. Every variant carries a `json` flag because
 * `--json`, `--help`, and `--version` are accepted by every command. Optional
 * fields are omitted (never set to `undefined`) so the shape stays exact.
 */
export type ParsedCommand =
  | { kind: "help"; topic?: string; json: boolean }
  | { kind: "version"; json: boolean }
  | {
      kind: "add";
      text?: string;
      stdin: boolean;
      source: CaptureSource;
      model?: string;
      category?: string;
      tags: readonly string[];
      json: boolean;
    }
  | {
      kind: "list";
      repo: "auto" | "current" | "all";
      sinceMs?: number;
      limit: number;
      includeResolved?: true;
      json: boolean;
    }
  | {
      kind: "stats";
      repo: "auto" | "current" | "all";
      sinceMs?: number;
      includeResolved?: true;
      json: boolean;
    }
  | {
      kind: "export";
      repo: "auto" | "current" | "all";
      sinceMs?: number;
      output?: string;
      force: boolean;
      includeResolved?: true;
      json: boolean;
    }
  | {
      kind: "setup";
      harness: Harness;
      scope: "user" | "repo";
      undo: boolean;
      apply: boolean;
      json: boolean;
    }
  | { kind: "resolve" | "reopen"; id: string; json: boolean }
  | { kind: "doctor"; json: boolean };

type HelpCommand = Extract<ParsedCommand, { kind: "help" }>;
type AddCommand = Extract<ParsedCommand, { kind: "add" }>;
type ListCommand = Extract<ParsedCommand, { kind: "list" }>;
type StatsCommand = Extract<ParsedCommand, { kind: "stats" }>;
type ExportCommand = Extract<ParsedCommand, { kind: "export" }>;
type SetupCommand = Extract<ParsedCommand, { kind: "setup" }>;
type DoctorCommand = Extract<ParsedCommand, { kind: "doctor" }>;
type LifecycleCommand = Extract<ParsedCommand, { kind: "resolve" | "reopen" }>;

type RepoScope = "auto" | "current" | "all";

const MAX_BODY_BYTES = 65_536;
const MAX_MODEL_BYTES = 256;
const MAX_CATEGORY_BYTES = 64;
const MAX_TAG_BYTES = 64;
const MAX_TAGS = 16;
const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 1000;

const DURATION_UNIT_MS = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

const COMMAND_WORDS = new Set([
  "add",
  "list",
  "stats",
  "export",
  "resolve",
  "reopen",
  "setup",
  "doctor",
]);
const CAPTURE_SOURCES = new Set<CaptureSource>([
  "manual",
  "codex",
  "claude-code",
  "generic",
]);
const HARNESSES = new Set<Harness>(["codex", "claude-code", "generic"]);

/**
 * Parse process arguments into a {@link ParsedCommand}. Parsing is pure: it
 * resolves no filesystem paths and opens no store, so `--help` and `--version`
 * are answerable without touching the data directory. Every expected usage
 * failure is a {@link PapercutsError} with code `invalid_input` (exit code 2).
 */
export function parseArgs(argv: readonly string[]): ParsedCommand {
  const globals = extractGlobals(argv);
  const tokens = globals.tokens;
  const first = tokens[0];

  if (first === undefined) {
    if (globals.version && !globals.help) {
      return { kind: "version", json: globals.json };
    }
    return help(undefined, globals.json);
  }

  if (first.startsWith("-")) {
    // A dash-prefixed token where the command word is expected means a
    // command-specific flag was placed before its command (or is unknown).
    throw usageError();
  }

  const rest = tokens.slice(1);

  if (!COMMAND_WORDS.has(first)) {
    if (globals.help) {
      return help(undefined, globals.json);
    }
    if (globals.version) {
      return { kind: "version", json: globals.json };
    }
    throw usageError();
  }

  if (globals.help) {
    return help(first, globals.json);
  }
  if (globals.version) {
    return { kind: "version", json: globals.json };
  }

  switch (first) {
    case "add":
      return parseAdd(rest, globals.json);
    case "list":
      return parseList(rest, globals.json);
    case "stats":
      return parseStats(rest, globals.json);
    case "export":
      return parseExport(rest, globals.json);
    case "resolve":
    case "reopen":
      return parseLifecycle(first, rest, globals.json);
    case "setup":
      return parseSetup(rest, globals.json);
    default:
      return parseDoctor(rest, globals.json);
  }
}

/**
 * Split the never-valued global flags out of `argv` wherever they appear, so a
 * command word can be found regardless of flag position. `--json`, `--help`,
 * `-h`, and `--version` are treated as booleans and are never consumed as an
 * option value; the remaining tokens preserve their original order.
 */
function extractGlobals(argv: readonly string[]): {
  tokens: string[];
  json: boolean;
  help: boolean;
  version: boolean;
} {
  const tokens: string[] = [];
  let json = false;
  let help = false;
  let version = false;

  for (const token of argv) {
    if (token === "--json") {
      json = true;
    } else if (token === "--help" || token === "-h") {
      help = true;
    } else if (token === "--version") {
      version = true;
    } else {
      tokens.push(token);
    }
  }

  return { tokens, json, help, version };
}

function help(topic: string | undefined, json: boolean): HelpCommand {
  const command: HelpCommand = { kind: "help", json };
  if (topic !== undefined) {
    command.topic = topic;
  }
  return command;
}

function parseAdd(rest: readonly string[], json: boolean): AddCommand {
  let text: string | undefined;
  let stdin = false;
  let source: CaptureSource = "manual";
  let sourceSeen = false;
  let model: string | undefined;
  let category: string | undefined;
  const tags: string[] = [];
  let positionalCount = 0;
  let optionsEnded = false;
  let index = 0;

  while (index < rest.length) {
    const token = rest[index] as string;
    const { name, inline } = splitToken(token);

    if (!optionsEnded && name === "--" && inline === undefined) {
      optionsEnded = true;
      index += 1;
      continue;
    }

    if (!optionsEnded && name === "--stdin") {
      rejectInlineValue(inline);
      stdin = true;
      index += 1;
      continue;
    }

    if (!optionsEnded && name === "--source") {
      if (sourceSeen) {
        throw usageError();
      }
      const read = optionValue(rest, index, inline);
      if (!CAPTURE_SOURCES.has(read.value as CaptureSource)) {
        throw usageError();
      }
      source = read.value as CaptureSource;
      sourceSeen = true;
      index = read.nextIndex;
      continue;
    }

    if (!optionsEnded && name === "--model") {
      if (model !== undefined) {
        throw usageError();
      }
      const read = optionValue(rest, index, inline);
      if (!withinTextBounds(read.value, MAX_MODEL_BYTES)) {
        throw usageError();
      }
      model = read.value;
      index = read.nextIndex;
      continue;
    }

    if (!optionsEnded && name === "--category") {
      if (category !== undefined) {
        throw usageError();
      }
      const read = optionValue(rest, index, inline);
      if (!withinTextBounds(read.value, MAX_CATEGORY_BYTES)) {
        throw usageError();
      }
      category = read.value;
      index = read.nextIndex;
      continue;
    }

    if (!optionsEnded && name === "--tag") {
      const read = optionValue(rest, index, inline);
      if (!isAcceptableTag(read.value)) {
        throw usageError();
      }
      if (tags.length >= MAX_TAGS) {
        throw usageError();
      }
      tags.push(read.value);
      index = read.nextIndex;
      continue;
    }

    if (!optionsEnded && token.startsWith("-")) {
      throw usageError();
    }

    positionalCount += 1;
    if (positionalCount > 1 || !withinTextBounds(token, MAX_BODY_BYTES)) {
      throw usageError();
    }
    text = token;
    index += 1;
  }

  // Exactly one of a positional body or `--stdin` is required.
  if ((text !== undefined) === stdin) {
    throw usageError();
  }

  const command: AddCommand = {
    kind: "add",
    stdin,
    source,
    tags: Object.freeze([...tags]),
    json,
  };
  if (text !== undefined) {
    command.text = text;
  }
  if (model !== undefined) {
    command.model = model;
  }
  if (category !== undefined) {
    command.category = category;
  }
  return command;
}

function parseList(rest: readonly string[], json: boolean): ListCommand {
  let repo: RepoScope = "auto";
  let repoSeen = false;
  let sinceMs: number | undefined;
  let limit = DEFAULT_LIMIT;
  let limitSeen = false;
  let includeResolved = false;
  let index = 0;

  while (index < rest.length) {
    const { name, inline } = splitToken(rest[index] as string);

    if (name === "--repo") {
      if (repoSeen) {
        throw usageError();
      }
      const read = optionValue(rest, index, inline);
      repo = parseExplicitRepoScope(read.value);
      repoSeen = true;
      index = read.nextIndex;
      continue;
    }

    if (name === "--since") {
      if (sinceMs !== undefined) {
        throw usageError();
      }
      const read = optionValue(rest, index, inline);
      sinceMs = parseDurationMs(read.value);
      index = read.nextIndex;
      continue;
    }

    if (name === "--limit") {
      if (limitSeen) {
        throw usageError();
      }
      const read = optionValue(rest, index, inline);
      limit = parseLimit(read.value);
      limitSeen = true;
      index = read.nextIndex;
      continue;
    }

    if (name === "--include-resolved") {
      if (includeResolved) throw usageError();
      rejectInlineValue(inline);
      includeResolved = true;
      index += 1;
      continue;
    }

    throw usageError();
  }

  const command: ListCommand = { kind: "list", repo, limit, json };
  if (sinceMs !== undefined) {
    command.sinceMs = sinceMs;
  }
  if (includeResolved) command.includeResolved = true;
  return command;
}

function parseStats(rest: readonly string[], json: boolean): StatsCommand {
  let repo: RepoScope = "auto";
  let repoSeen = false;
  let sinceMs: number | undefined;
  let includeResolved = false;
  let index = 0;

  while (index < rest.length) {
    const { name, inline } = splitToken(rest[index] as string);

    if (name === "--repo") {
      if (repoSeen) {
        throw usageError();
      }
      const read = optionValue(rest, index, inline);
      repo = parseExplicitRepoScope(read.value);
      repoSeen = true;
      index = read.nextIndex;
      continue;
    }

    if (name === "--since") {
      if (sinceMs !== undefined) {
        throw usageError();
      }
      const read = optionValue(rest, index, inline);
      sinceMs = parseDurationMs(read.value);
      index = read.nextIndex;
      continue;
    }

    if (name === "--include-resolved") {
      if (includeResolved) throw usageError();
      rejectInlineValue(inline);
      includeResolved = true;
      index += 1;
      continue;
    }

    throw usageError();
  }

  const command: StatsCommand = { kind: "stats", repo, json };
  if (sinceMs !== undefined) {
    command.sinceMs = sinceMs;
  }
  if (includeResolved) command.includeResolved = true;
  return command;
}

function parseExport(rest: readonly string[], json: boolean): ExportCommand {
  let repo: RepoScope = "auto";
  let repoSeen = false;
  let sinceMs: number | undefined;
  let output: string | undefined;
  let force = false;
  let includeResolved = false;
  let index = 0;

  while (index < rest.length) {
    const token = rest[index] as string;
    const { name, inline } = splitToken(token);

    if (name === "--repo") {
      if (repoSeen) {
        throw usageError();
      }
      const read = optionValue(rest, index, inline);
      repo = parseExplicitRepoScope(read.value);
      repoSeen = true;
      index = read.nextIndex;
      continue;
    }

    if (name === "--since") {
      if (sinceMs !== undefined) {
        throw usageError();
      }
      const read = optionValue(rest, index, inline);
      sinceMs = parseDurationMs(read.value);
      index = read.nextIndex;
      continue;
    }

    if (name === "--output") {
      if (output !== undefined) {
        throw usageError();
      }
      const read = optionValue(rest, index, inline);
      if (!isAcceptableOutput(read.value)) {
        throw usageError();
      }
      output = read.value;
      index = read.nextIndex;
      continue;
    }

    if (name === "--force") {
      rejectInlineValue(inline);
      force = true;
      index += 1;
      continue;
    }

    if (name === "--include-resolved") {
      if (includeResolved) throw usageError();
      rejectInlineValue(inline);
      includeResolved = true;
      index += 1;
      continue;
    }

    throw usageError();
  }

  const command: ExportCommand = { kind: "export", repo, force, json };
  if (sinceMs !== undefined) {
    command.sinceMs = sinceMs;
  }
  if (output !== undefined) {
    command.output = output;
  }
  if (includeResolved) command.includeResolved = true;
  return command;
}

function parseLifecycle(
  kind: LifecycleCommand["kind"],
  rest: readonly string[],
  json: boolean,
): LifecycleCommand {
  const id = rest[0];
  if (rest.length !== 1 || id === undefined || !UUID_V4_PATTERN.test(id)) {
    throw usageError();
  }
  return { kind, id, json };
}

function parseSetup(rest: readonly string[], json: boolean): SetupCommand {
  let harness: Harness | undefined;
  let scope: "user" | "repo" = "user";
  let scopeSeen = false;
  let undo = false;
  let apply = false;
  let index = 0;

  while (index < rest.length) {
    const token = rest[index] as string;
    const { name, inline } = splitToken(token);

    if (name === "--scope") {
      if (scopeSeen) {
        throw usageError();
      }
      const read = optionValue(rest, index, inline);
      if (read.value !== "user" && read.value !== "repo") {
        throw usageError();
      }
      scope = read.value;
      scopeSeen = true;
      index = read.nextIndex;
      continue;
    }

    if (name === "--undo") {
      rejectInlineValue(inline);
      undo = true;
      index += 1;
      continue;
    }

    if (name === "--apply") {
      rejectInlineValue(inline);
      apply = true;
      index += 1;
      continue;
    }

    if (token.startsWith("-")) {
      throw usageError();
    }

    if (harness !== undefined || !HARNESSES.has(token as Harness)) {
      throw usageError();
    }
    harness = token as Harness;
    index += 1;
  }

  if (harness === undefined) {
    throw usageError();
  }

  return { kind: "setup", harness, scope, undo, apply, json };
}

function parseDoctor(rest: readonly string[], json: boolean): DoctorCommand {
  if (rest.length > 0) {
    throw usageError();
  }
  return { kind: "doctor", json };
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Split a token into an option name and an optional inline value. Only long
 * (`--name`) options support the `--name=value` form; every other token is
 * returned whole with no inline value.
 */
function splitToken(token: string): {
  name: string;
  inline: string | undefined;
} {
  if (token.startsWith("--")) {
    const separator = token.indexOf("=");
    if (separator !== -1) {
      return {
        name: token.slice(0, separator),
        inline: token.slice(separator + 1),
      };
    }
  }
  return { name: token, inline: undefined };
}

/**
 * Resolve the value for a value-taking option. An inline `--name=value` uses
 * its inline text; otherwise the following token is consumed. A missing value
 * is a usage error.
 */
function optionValue(
  rest: readonly string[],
  index: number,
  inline: string | undefined,
): { value: string; nextIndex: number } {
  if (inline !== undefined) {
    return { value: inline, nextIndex: index + 1 };
  }

  const value = rest[index + 1];
  if (value === undefined) {
    throw usageError();
  }
  return { value, nextIndex: index + 2 };
}

function rejectInlineValue(inline: string | undefined): void {
  if (inline !== undefined) {
    throw usageError();
  }
}

function parseExplicitRepoScope(value: string): RepoScope {
  if (value === "current" || value === "all") {
    return value;
  }
  throw usageError();
}

/**
 * Parse a `--since` window of the form `<positive integer><m|h|d>` into a
 * millisecond duration. The parser is pure, so this is a relative window width;
 * the runtime subtracts it from the current time to form an absolute bound.
 */
function parseDurationMs(value: string): number {
  const match = /^([0-9]+)([mhd])$/.exec(value);
  if (match === null) {
    throw usageError();
  }

  const magnitude = Number(match[1]);
  const unit = match[2] as keyof typeof DURATION_UNIT_MS;
  if (!Number.isSafeInteger(magnitude) || magnitude <= 0) {
    throw usageError();
  }

  const durationMs = magnitude * DURATION_UNIT_MS[unit];
  if (!Number.isSafeInteger(durationMs)) {
    throw usageError();
  }
  return durationMs;
}

function parseLimit(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw usageError();
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    throw usageError();
  }
  return limit;
}

function withinTextBounds(value: string, maxBytes: number): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function isAcceptableTag(value: string): boolean {
  return withinTextBounds(value, MAX_TAG_BYTES) && value.trim().length > 0;
}

function isAcceptableOutput(value: string): boolean {
  return value.length > 0 && !value.includes("\0");
}

function usageError(): PapercutsError {
  return new PapercutsError("invalid_input");
}
