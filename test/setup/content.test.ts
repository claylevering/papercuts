import { describe, expect, test } from "bun:test";

import {
  BEGIN_MARKER,
  END_MARKER,
  renderClaudeInstructions,
  renderCodexInstructions,
  renderGenericInstructions,
} from "../../src/setup/content";

describe("setup instruction content", () => {
  for (const [name, source, render] of [
    ["Codex", "codex", renderCodexInstructions],
    ["Claude Code", "claude-code", renderClaudeInstructions],
    ["generic harnesses", "generic", renderGenericInstructions],
  ] as const) {
    test(`${name} instructions are deterministic and complete`, () => {
      const first = render();

      expect(render()).toBe(first);
      expect(first).toStartWith(BEGIN_MARKER);
      expect(first).toEndWith(END_MARKER);
      expect(first).toContain("proactively record small, concrete friction");
      expect(first).toContain("without asking");
      expect(first).toContain("one or two sentences");
      expect(first).toContain("what you were doing");
      expect(first).toContain("what got in the way");
      expect(first).toContain("suspected cause or fix");
      expect(first).toContain("at most once per task");
      expect(first).toContain("Never include secrets");
      expect(first).toContain("raw transcripts");
      expect(first).toContain("large command output");
      expect(first).toContain("not an accomplishment log");
      expect(first).toContain("not a tracked bug");
      expect(first).toContain(
        `papercuts add --stdin --source ${source}`,
      );
      expect(first).toContain("continue the primary task");
      expect(first).toContain(
        "Never record a papercuts capture failure as another papercut",
      );
      expect(first).toContain("Never review transcripts automatically");
    });
  }

  test("uses the exact versioned managed markers", () => {
    expect(BEGIN_MARKER).toBe("<!-- papercuts:begin v1 -->");
    expect(END_MARKER).toBe("<!-- papercuts:end -->");
  });
});
