import type { RedactionResult, ScreenedText } from "../domain/types";

export const REDACTION_RULESET_VERSION = "1";

const REDACTION_RULES = [
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    marker: "[REDACTED:PRIVATE_KEY]",
  },
  {
    pattern: /\bAuthorization[ \t]*:[^\r\n]*/gi,
    marker: "[REDACTED:AUTHORIZATION]",
  },
  {
    pattern: /\bCookie[ \t]*:[^\r\n]*/gi,
    marker: "[REDACTED:COOKIE]",
  },
  {
    pattern:
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:[^\s@/]+@[^\s]+/gi,
    marker: "[REDACTED:URL_CREDENTIAL]",
  },
] as const;

const SECRET_ASSIGNMENT_PREFIX =
  /\b(?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:token|secret|password|passwd|key)(?:[_-][A-Za-z0-9_-]+)?[ \t]*[:=][ \t]*/gi;

const CREDENTIAL_PREFIXES = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
] as const;

export function redact(raw: string): RedactionResult {
  let replacementCount = 0;
  let text = raw;

  for (const { pattern, marker } of REDACTION_RULES) {
    text = text.replace(pattern, () => {
      replacementCount += 1;
      return marker;
    });
  }

  const secretAssignments = redactSecretAssignments(text);
  text = secretAssignments.text;
  replacementCount += secretAssignments.replacementCount;

  for (const pattern of CREDENTIAL_PREFIXES) {
    text = text.replace(pattern, () => {
      replacementCount += 1;
      return "[REDACTED:CREDENTIAL]";
    });
  }

  return {
    text: text as ScreenedText,
    replacementCount,
    rulesetVersion: REDACTION_RULESET_VERSION,
  };
}

function redactSecretAssignments(raw: string): {
  text: string;
  replacementCount: number;
} {
  const parts: string[] = [];
  let cursor = 0;
  let replacementCount = 0;

  for (const match of raw.matchAll(SECRET_ASSIGNMENT_PREFIX)) {
    if (match.index < cursor) {
      continue;
    }

    const valueStart = match.index + match[0].length;
    const valueEnd = findSecretValueEnd(raw, valueStart);

    if (valueEnd === valueStart) {
      continue;
    }

    parts.push(raw.slice(cursor, match.index), "[REDACTED:SECRET]");
    cursor = valueEnd;
    replacementCount += 1;
  }

  if (replacementCount === 0) {
    return { text: raw, replacementCount };
  }

  parts.push(raw.slice(cursor));
  return { text: parts.join(""), replacementCount };
}

function findSecretValueEnd(raw: string, valueStart: number): number {
  const quote = raw[valueStart];

  if (quote === '"' || quote === "'") {
    return findQuotedSecretValueEnd(raw, valueStart, quote);
  }

  let index = valueStart;

  while (index < raw.length) {
    const character = raw[index];

    if (
      character === undefined ||
      character === "," ||
      character === ";" ||
      /\s/.test(character)
    ) {
      break;
    }

    index += 1;
  }

  return index;
}

function findQuotedSecretValueEnd(
  raw: string,
  valueStart: number,
  quote: '"' | "'",
): number {
  let index = valueStart + 1;

  while (index < raw.length) {
    const character = raw[index];

    if (character === quote) {
      return index + 1;
    }

    if (character === "\r" || character === "\n") {
      return index;
    }

    if (character === "\\") {
      const escaped = raw[index + 1];

      if (escaped === undefined) {
        return raw.length;
      }

      if (escaped === "\r" || escaped === "\n") {
        return index + 1;
      }

      index += 2;
      continue;
    }

    index += 1;
  }

  return index;
}

export function mapScreenedText(
  text: ScreenedText,
  transform: (text: string) => string,
): ScreenedText {
  return transform(text) as ScreenedText;
}
