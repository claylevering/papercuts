import { describe, expect, test } from "bun:test";

import type {
  Papercut,
  RepoContext,
  ScreenedText,
} from "../../src/domain/types";
import { renderMarkdown } from "../../src/views/markdown";

describe("renderMarkdown", () => {
  test("renders a deterministic empty export without generation time", () => {
    const first = renderMarkdown([], { kind: "all" });
    const second = renderMarkdown([], { kind: "all" });

    expect(first).toBe(second);
    expect(first).toBe(
      "# Papercuts\n\nScope: all repositories\n\n_No papercuts found._\n",
    );
    expect(first).not.toContain("Generated");
  });

  test("uses longer fences for hostile bodies and makes each metadata field inert", () => {
    const body = [
      "---",
      "title: injected front matter",
      "---",
      "# Injected heading",
      "<body-canary>raw HTML in the body</body-canary>",
      "Unicode: 雪 😀 café",
      "````````````",
      "[REDACTED:CREDENTIAL]",
    ].join("\n");
    const record = makeHostilePapercut({ body: screened(body) });
    const scope = {
      kind: "current" as const,
      repository: {
        name: "scope`````````<scope-canary>&",
      },
    };

    const first = renderMarkdown([record], scope);
    const second = renderMarkdown([record], scope);

    expect(first).toBe(second);
    const bodyFence = "`".repeat(13);
    expect(first).toContain(`\n${bodyFence}\n${body}\n${bodyFence}\n`);
    expect(first).toContain(
      "``````````scope`````````&lt;scope-canary&gt;&amp;``````````",
    );
    expect(first).toContain("```repo``&lt;repo-canary&gt;&amp;```");
    expect(first).toContain("````branch```&lt;branch-canary&gt;&amp;````");
    expect(first).toContain("`````cwd````&lt;cwd-canary&gt;&amp;`````");
    expect(first).toContain(
      "``````model`````&lt;model-canary&gt;&amp;``````",
    );
    expect(first).toContain(
      "```````category``````&lt;category-canary&gt;&amp;```````",
    );
    expect(first).toContain(
      "````````tag```````&lt;tag-one-canary&gt;&amp;````````",
    );
    expect(first).toContain(
      "`````````tag````````&lt;tag-two-canary&gt;&amp;`````````",
    );

    for (const canary of [
      "<scope-canary>",
      "<repo-canary>",
      "<branch-canary>",
      "<cwd-canary>",
      "<model-canary>",
      "<category-canary>",
      "<tag-one-canary>",
      "<tag-two-canary>",
    ]) {
      expect(first).not.toContain(canary);
    }
    expect(first).not.toContain("/Users/private/ABSOLUTE_ROOT_CANARY");
    expect(first).not.toContain("REPOSITORY_KEY_CANARY");
    expect(first).not.toContain("HEAD_COMMIT_CANARY");
    expect(first).not.toContain("Generated");
  });

  test("omits repository and optional metadata when absent", () => {
    const output = renderMarkdown(
      [
        makePapercut({
          repo: null,
          model: null,
          category: null,
          tags: [],
        }),
      ],
      { kind: "all" },
    );

    expect(output).not.toContain("Repository:");
    expect(output).not.toContain("Branch:");
    expect(output).not.toContain("Working directory:");
    expect(output).not.toContain("Model:");
    expect(output).not.toContain("Category:");
    expect(output).not.toContain("Tags:");
  });

  test("separates inline delimiters from metadata boundary backticks", () => {
    const record = makePapercut({
      repo: makeRepo({
        displayName: screened("repo-end<repo-edge-canary>&`"),
      }),
    });

    const output = renderMarkdown([record], {
      kind: "current",
      repository: {
        name: "`scope-start\n# metadata heading <scope-edge-canary>&",
      },
    });

    expect(output).toContain(
      "`` `scope-start\n# metadata heading &lt;scope-edge-canary&gt;&amp; ``",
    );
    expect(output).toContain(
      "`` repo-end&lt;repo-edge-canary&gt;&amp;` ``",
    );
  });
});

function screened(value: string): ScreenedText {
  return value as ScreenedText;
}

function makeRepo(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    key: "REPOSITORY_KEY_CANARY",
    keyKind: "remote",
    displayName: screened("papercuts"),
    root: screened("/Users/private/ABSOLUTE_ROOT_CANARY"),
    cwdRelative: screened("src/views"),
    branch: screened("task/views"),
    head: screened("HEAD_COMMIT_CANARY"),
    ...overrides,
  };
}

function makePapercut(overrides: Partial<Papercut> = {}): Papercut {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    createdAtMs: Date.parse("2026-07-10T12:34:56.789Z"),
    body: screened("A multiline observation.\nIts second line."),
    source: "codex",
    model: null,
    category: null,
    tags: [],
    clientVersion: "0.1.0",
    repo: makeRepo(),
    redactionCount: 0,
    redactionVersion: "1",
    ...overrides,
  };
}

function makeHostilePapercut(overrides: Partial<Papercut> = {}): Papercut {
  return makePapercut({
    repo: makeRepo({
      displayName: screened("repo``<repo-canary>&"),
      branch: screened("branch```<branch-canary>&"),
      cwdRelative: screened("cwd````<cwd-canary>&"),
    }),
    model: screened("model`````<model-canary>&"),
    category: screened("category``````<category-canary>&"),
    tags: [
      screened("tag```````<tag-one-canary>&"),
      screened("tag````````<tag-two-canary>&"),
    ],
    ...overrides,
  });
}
