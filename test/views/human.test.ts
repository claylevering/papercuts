import { describe, expect, test } from "bun:test";

import type {
  Papercut,
  RepoContext,
  ScreenedText,
} from "../../src/domain/types";
import { renderList, renderStats } from "../../src/views/human";
import { summarize } from "../../src/views/stats";

describe("renderList", () => {
  test("renders an explicit empty result for all repositories", () => {
    expect(renderList([], { kind: "all" })).toBe(
      "Papercuts — all repositories\n\nNo papercuts found.\n",
    );
  });

  test("keeps hostile metadata inert while preserving the full body", () => {
    const body = [
      "---",
      "# Body heading",
      "<body-canary>body HTML remains redacted content</body-canary>",
      "Unicode: 雪 😀 café",
      "Twelve backticks: ````````````",
      "[REDACTED:SECRET]",
    ].join("\n");
    const record = makeHostilePapercut({ body: screened(body) });
    const scope = {
      kind: "current" as const,
      repository: {
        name: "scope`````````<scope-canary>&",
      },
    };

    const first = renderList([record], scope);
    const second = renderList([record], scope);

    expect(first).toBe(second);
    expect(first).toContain(body);
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
  });

  test("omits repository and optional metadata when absent", () => {
    const output = renderList(
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

    const output = renderList([record], {
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

describe("renderStats", () => {
  test("renders structural empty sections without invented analysis", () => {
    const output = renderStats(summarize([]), { kind: "all" });

    expect(output).toContain("Total: 0");
    expect(output).toContain("First: —");
    expect(output).toContain("Last: —");
    expect(output).toContain("Exact repeats:\n  (none)");
    expect(output).not.toContain("Topic");
    expect(output).not.toContain("Cause");
    expect(output).not.toContain("Priority");
  });

  test("renders hostile summary labels and repeated bodies as inert code spans", () => {
    const record = makePapercut({
      body: screened("repeat``<repeat-canary>&\n# still data"),
      category: screened("category```<stats-category-canary>&"),
      repo: makeRepo({
        displayName: screened("repo````<stats-repo-canary>&"),
      }),
    });
    const summary = summarize([record, record]);

    const output = renderStats(summary, {
      kind: "current",
      repository: { name: "scope`<stats-scope-canary>&" },
    });

    expect(output).toContain("``scope`&lt;stats-scope-canary&gt;&amp;``");
    expect(output).toContain(
      "`````repo````&lt;stats-repo-canary&gt;&amp;`````",
    );
    expect(output).toContain(
      "````category```&lt;stats-category-canary&gt;&amp;````",
    );
    expect(output).toContain(
      "```repeat``&lt;repeat-canary&gt;&amp;\n# still data``` × 2",
    );
    expect(output).not.toContain("<stats-scope-canary>");
    expect(output).not.toContain("<stats-repo-canary>");
    expect(output).not.toContain("<stats-category-canary>");
    expect(output).not.toContain("<repeat-canary>");
  });
});

function screened(value: string): ScreenedText {
  return value as ScreenedText;
}

function makeRepo(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    key: "REPOSITORY_KEY_CANARY",
    keyKind: "local",
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
