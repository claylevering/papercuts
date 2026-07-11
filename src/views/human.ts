import type { Papercut } from "../domain/types";
import type { StatsSummary } from "./stats";

export type ScopeDescriptor =
  | { kind: "all" }
  | { kind: "current"; repository: { name: string } };

export function renderList(
  records: readonly Papercut[],
  scope: ScopeDescriptor,
): string {
  const lines = [`Papercuts — ${renderScope(scope)}`, ""];

  if (records.length === 0) {
    lines.push("No papercuts found.");
    return `${lines.join("\n")}\n`;
  }

  records.forEach((record, index) => {
    if (index > 0) lines.push("");
    lines.push(
      `${index + 1}. Created: ${inlineCode(new Date(record.createdAtMs).toISOString())}`,
      `   Source: ${inlineCode(record.source)}`,
    );
    if (record.repo !== null) {
      lines.push(`   Repository: ${inlineCode(record.repo.displayName)}`);
      if (record.repo.branch !== null) {
        lines.push(`   Branch: ${inlineCode(record.repo.branch)}`);
      }
      lines.push(`   Working directory: ${inlineCode(record.repo.cwdRelative)}`);
    }
    if (record.model !== null) {
      lines.push(`   Model: ${inlineCode(record.model)}`);
    }
    if (record.category !== null) {
      lines.push(`   Category: ${inlineCode(record.category)}`);
    }
    if (record.tags.length > 0) {
      lines.push(`   Tags: ${record.tags.map(inlineCode).join(", ")}`);
    }
    lines.push("   Body:", record.body);
  });

  return `${lines.join("\n")}\n`;
}

export function renderStats(
  summary: StatsSummary,
  scope: ScopeDescriptor,
): string {
  const lines = [
    `Papercut statistics — ${renderScope(scope)}`,
    "",
    `Total: ${summary.total}`,
    `First: ${renderOptionalTimestamp(summary.firstAt)}`,
    `Last: ${renderOptionalTimestamp(summary.lastAt)}`,
    `Redacted records: ${summary.redactedRecordCount}`,
    `Replacements: ${summary.replacementCount}`,
    "",
  ];

  appendCountSection(lines, "By day", summary.byDay);
  appendCountSection(lines, "By source", summary.bySource);
  appendCountSection(lines, "By repository", summary.byRepository);
  appendCountSection(lines, "By category", summary.byCategory);
  lines.push("Exact repeats:");
  if (summary.exactRepeats.length === 0) {
    lines.push("  (none)");
  } else {
    for (const repeat of [...summary.exactRepeats].sort(({ body: left }, { body: right }) =>
      compareLexically(left, right),
    )) {
      lines.push(`  ${inlineCode(repeat.body)} × ${repeat.count}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderScope(scope: ScopeDescriptor): string {
  return scope.kind === "all"
    ? "all repositories"
    : `current repository ${inlineCode(scope.repository.name)}`;
}

function renderOptionalTimestamp(value: string | null): string {
  return value === null ? "—" : inlineCode(value);
}

function appendCountSection(
  lines: string[],
  title: string,
  counts: Readonly<Record<string, number>>,
): void {
  lines.push(`${title}:`);
  const entries = Object.entries(counts).sort(([left], [right]) =>
    compareLexically(left, right),
  );
  if (entries.length === 0) {
    lines.push("  (none)", "");
    return;
  }
  for (const [label, count] of entries) {
    lines.push(`  ${inlineCode(label)}: ${count}`);
  }
  lines.push("");
}

function inlineCode(value: string): string {
  const escaped = escapeMetadata(value);
  const delimiter = "`".repeat(longestBacktickRun(escaped) + 1);
  const padding =
    escaped.length === 0 || escaped.startsWith("`") || escaped.endsWith("`")
      ? " "
      : "";
  return `${delimiter}${padding}${escaped}${padding}${delimiter}`;
}

function escapeMetadata(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  for (const run of value.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }
  return longest;
}

function compareLexically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
