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
  {
    pattern:
      /\b(?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:token|secret|password|passwd|key)(?:[_-][A-Za-z0-9_-]+)?[ \t]*[:=][ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    marker: "[REDACTED:SECRET]",
  },
] as const;

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

export function mapScreenedText(
  text: ScreenedText,
  transform: (text: string) => string,
): ScreenedText {
  return transform(text) as ScreenedText;
}
