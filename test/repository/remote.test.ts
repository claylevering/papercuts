import { describe, expect, test } from "bun:test";

import { normalizeRemote } from "../../src/repository/remote";

describe("normalizeRemote", () => {
  test.each([
    [
      "https://user:pass@Example.COM/Owner/Repo.git?token=hidden#fragment",
      "example.com/Owner/Repo",
    ],
    [
      "ssh://git@example.com:22/Owner/Repo.git",
      "example.com/Owner/Repo",
    ],
    ["git@example.com:Owner/Repo.git", "example.com/Owner/Repo"],
    [
      "ssh://git@example.com:2222/Owner/Repo.git",
      "example.com:2222/Owner/Repo",
    ],
  ] as const)("normalizes %s", (raw, expected) => {
    expect(normalizeRemote(raw)).toBe(expected);
  });

  test("normalizes hostname case, default ports, separators, and trailing syntax", () => {
    expect(
      normalizeRemote(
        "https://EXAMPLE.com:443//Owner///Repo.git/?access_token=discarded#discarded",
      ),
    ).toBe("example.com/Owner/Repo");
  });

  test("preserves repository path case", () => {
    expect(normalizeRemote("https://example.com/OWNER/MixedCase.git")).toBe(
      "example.com/OWNER/MixedCase",
    );
  });

  test("returns only credential-free host, optional port, and path", () => {
    const password = "password-canary";
    const token = "token-canary";
    const fragment = "fragment-canary";
    const normalized = normalizeRemote(
      `https://named-user:${password}@example.com/Owner/Repo.git?token=${token}#${fragment}`,
    );

    expect(normalized).toBe("example.com/Owner/Repo");
    expect(normalized).not.toContain("named-user");
    expect(normalized).not.toContain(password);
    expect(normalized).not.toContain(token);
    expect(normalized).not.toContain(fragment);
  });

  test.each([
    "",
    "not a remote",
    "https://example.com",
    "file:///tmp/repository.git",
    "git@example.com:",
    "ssh://example.com/",
    "C:\\local\\repository.git",
    "user@host@other:Owner/Repo.git",
  ])("returns null for malformed or ambiguous input without throwing", (raw) => {
    expect(() => normalizeRemote(raw)).not.toThrow();
    expect(normalizeRemote(raw)).toBeNull();
  });
});
