import { describe, expect, test } from "bun:test";

import {
  REDACTION_RULESET_VERSION,
  mapScreenedText,
  redact,
} from "../../src/security/redactor";

describe("redact", () => {
  for (const [raw, marker] of [
    [`Authorization: Bearer ${"A".repeat(32)}`, "[REDACTED:AUTHORIZATION]"],
    [`Cookie: session=${"B".repeat(32)}`, "[REDACTED:COOKIE]"],
    [
      `https://user:${"C".repeat(24)}@example.test/repo`,
      "[REDACTED:URL_CREDENTIAL]",
    ],
    [`API_TOKEN=${"D".repeat(32)}`, "[REDACTED:SECRET]"],
    [`ghp_${"E".repeat(24)}`, "[REDACTED:CREDENTIAL]"],
  ] as const) {
    test(`redacts ${marker}`, () => {
      const result = redact(raw);

      expect(result.text).toContain(marker);
      expect(result.text).not.toContain(raw);
      expect(result.replacementCount).toBeGreaterThan(0);
    });
  }

  test("redacts a private-key block with a class-only marker", () => {
    const raw = [
      "-----BEGIN PRIVATE KEY-----",
      "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    const result = redact(raw);

    expect(String(result.text)).toBe("[REDACTED:PRIVATE_KEY]");
    expect(result.replacementCount).toBe(1);
  });

  for (const [name, raw] of [
    ["GitHub", "ghp_" + "A".repeat(24)],
    ["OpenAI-style", "sk-" + "B".repeat(24)],
    ["Slack", "xoxb-" + "C".repeat(16)],
  ] as const) {
    test(`redacts a recognized ${name} credential prefix`, () => {
      const result = redact(raw);

      expect(String(result.text)).toBe("[REDACTED:CREDENTIAL]");
      expect(result.replacementCount).toBe(1);
    });
  }

  test("uses only typed class markers for replacements", () => {
    const raw = `before API_TOKEN=${"D".repeat(32)} after`;

    expect(String(redact(raw).text)).toBe("before [REDACTED:SECRET] after");
  });

  for (const [name, raw] of [
    ["short credential lookalikes", "ghp_short sk-short xoxb-short"],
    ["ordinary prose", "Please keep this note concise and useful."],
    ["filesystem paths", "/Users/example/project/src/index.ts"],
    ["commit hashes", "0123456789abcdef0123456789abcdef01234567"],
    ["non-secret key names", "MONKEY=banana KEYBOARD_LAYOUT=dvorak"],
  ] as const) {
    test(`preserves ${name}`, () => {
      const result = redact(raw);

      expect(String(result.text)).toBe(raw);
      expect(result.replacementCount).toBe(0);
    });
  }

  test("is idempotent", () => {
    const raw = [
      `Authorization: Bearer ${"A".repeat(32)}`,
      `API_TOKEN=${"B".repeat(32)}`,
    ].join("\n");

    const first = redact(raw);
    const second = redact(first.text);

    expect(second.text).toBe(first.text);
    expect(second.replacementCount).toBe(0);
    expect(second.rulesetVersion).toBe(REDACTION_RULESET_VERSION);
  });

  test("completes a long credential near-match promptly", () => {
    const raw = "ghp_" + "A".repeat(19) + "!".repeat(100_000);
    const startedAt = performance.now();

    const result = redact(raw);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(String(result.text)).toBe(raw);
    expect(result.replacementCount).toBe(0);
  });
});

describe("mapScreenedText", () => {
  test("transforms screened text while preserving its screened value", () => {
    const screened = redact("  SAFE TAG  ").text;

    const mapped = mapScreenedText(screened, (text) => text.trim().toLowerCase());

    expect(String(mapped)).toBe("safe tag");
  });
});
