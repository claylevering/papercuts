import { PapercutsError } from "../domain/errors";
import type {
  CaptureReceipt,
  CaptureSource,
  Papercut,
  PapercutStore,
  RedactionResult,
  ResolvedRepoContext,
  ScreenedText,
} from "../domain/types";
import {
  normalizeScreenedTag,
  redact,
  REDACTION_RULESET_VERSION,
} from "../security/redactor";

const MAX_BODY_BYTES = 65_536;
const MAX_MODEL_BYTES = 256;
const MAX_CATEGORY_BYTES = 64;
const MAX_TAG_BYTES = 64;
const MAX_TAGS = 16;
const CAPTURE_SOURCES = new Set<CaptureSource>([
  "manual",
  "codex",
  "claude-code",
  "generic",
]);
const REPOSITORY_WARNING =
  "Repository context was unavailable; captured without repository attribution.";

export interface CaptureInput {
  body: string;
  source: CaptureSource;
  model?: string;
  category?: string;
  tags?: readonly string[];
  cwd: string;
}

export interface CaptureServiceDependencies {
  store: PapercutStore;
  resolveRepoContext(cwd: string): Promise<ResolvedRepoContext | null>;
  now(): number;
  randomUUID(): string;
  clientVersion: string;
}

export interface CaptureService {
  capture(input: CaptureInput): Promise<{
    receipt: CaptureReceipt;
    warnings: readonly string[];
  }>;
}

export function createCaptureService(
  dependencies: CaptureServiceDependencies,
): CaptureService {
  return {
    async capture(input: CaptureInput) {
      validateInput(input);

      const body = screen(input.body);
      const model = screenOptional(input.model);
      const category = screenOptional(input.category);
      const screenedTags = screenTags(input.tags ?? []);

      assertScreenedBound(body.text, MAX_BODY_BYTES);
      if (model !== null) {
        assertScreenedBound(model.text, MAX_MODEL_BYTES);
      }
      if (category !== null) {
        assertScreenedBound(category.text, MAX_CATEGORY_BYTES);
      }

      const observationRedactionCount =
        body.replacementCount +
        (model?.replacementCount ?? 0) +
        (category?.replacementCount ?? 0) +
        screenedTags.replacementCount;
      const { resolvedRepository, warnings } = await resolveRepository(
        dependencies,
        input.cwd,
      );
      const repo =
        resolvedRepository === null
          ? null
          : Object.freeze({ ...resolvedRepository.context });
      const redactionCount =
        observationRedactionCount +
        (resolvedRepository?.redactionCount ?? 0);
      const id = dependencies.randomUUID();
      const createdAtMs = dependencies.now();
      const record: Papercut = Object.freeze({
        id,
        createdAtMs,
        body: body.text,
        source: input.source,
        model: model?.text ?? null,
        category: category?.text ?? null,
        tags: screenedTags.tags,
        clientVersion: dependencies.clientVersion,
        repo,
        redactionCount,
        redactionVersion: REDACTION_RULESET_VERSION,
      });

      dependencies.store.append(record);

      const receipt: CaptureReceipt = Object.freeze({
        id,
        createdAtMs,
        source: input.source,
        repository:
          repo === null
            ? null
            : Object.freeze({
                name: repo.displayName,
              }),
        redactionCount,
      });

      return Object.freeze({ receipt, warnings });
    },
  };
}

function validateInput(input: CaptureInput): void {
  if (
    typeof input !== "object" ||
    input === null ||
    !isValidRequiredText(input.body, MAX_BODY_BYTES) ||
    !CAPTURE_SOURCES.has(input.source) ||
    !isValidCwd(input.cwd) ||
    !isValidOptionalText(input.model, MAX_MODEL_BYTES) ||
    !isValidOptionalText(input.category, MAX_CATEGORY_BYTES) ||
    !Array.isArray(input.tags ?? []) ||
    (input.tags?.length ?? 0) > MAX_TAGS
  ) {
    throw new PapercutsError("invalid_input");
  }

  for (const tag of input.tags ?? []) {
    if (!isValidRequiredText(tag, MAX_TAG_BYTES)) {
      throw new PapercutsError("invalid_input");
    }
  }
}

function isValidRequiredText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    isWellFormed(value) &&
    utf8ByteLength(value) <= maxBytes
  );
}

function isValidOptionalText(
  value: unknown,
  maxBytes: number,
): value is string | undefined {
  return value === undefined || isValidRequiredText(value, maxBytes);
}

function isValidCwd(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    isWellFormed(value)
  );
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }

  return true;
}

function screen(raw: string): RedactionResult {
  try {
    return redact(raw);
  } catch {
    throw new PapercutsError("safety_failure");
  }
}

function screenOptional(raw: string | undefined): RedactionResult | null {
  return raw === undefined ? null : screen(raw);
}

function screenTags(rawTags: readonly string[]): {
  tags: readonly ScreenedText[];
  replacementCount: number;
} {
  const uniqueTags = new Set<ScreenedText>();
  let replacementCount = 0;

  for (const rawTag of rawTags) {
    const result = screen(rawTag);
    const normalized = normalizeScreenedTag(result.text);

    if (normalized.length === 0) {
      throw new PapercutsError("invalid_input");
    }

    assertScreenedBound(normalized, MAX_TAG_BYTES);

    replacementCount += result.replacementCount;
    uniqueTags.add(normalized);
  }

  return {
    tags: Object.freeze([...uniqueTags].sort()),
    replacementCount,
  };
}

function assertScreenedBound(text: ScreenedText, maxBytes: number): void {
  if (utf8ByteLength(text) > maxBytes) {
    throw new PapercutsError("invalid_input");
  }
}

async function resolveRepository(
  dependencies: CaptureServiceDependencies,
  cwd: string,
): Promise<{
  resolvedRepository: ResolvedRepoContext | null;
  warnings: readonly string[];
}> {
  try {
    return {
      resolvedRepository: await dependencies.resolveRepoContext(cwd),
      warnings: Object.freeze([]),
    };
  } catch (error) {
    if (error instanceof PapercutsError && error.code === "safety_failure") {
      throw error;
    }

    return {
      resolvedRepository: null,
      warnings: Object.freeze([REPOSITORY_WARNING]),
    };
  }
}
