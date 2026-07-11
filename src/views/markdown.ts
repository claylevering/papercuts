import type { Papercut } from "../domain/types";
import type { ScopeDescriptor } from "./human";

export function renderMarkdown(
  records: readonly Papercut[],
  scope: ScopeDescriptor,
): string {
  const lines = ["# Papercuts", "", `Scope: ${renderScope(scope)}`, ""];

  if (records.length === 0) {
    lines.push("_No papercuts found._");
    return `${lines.join("\n")}\n`;
  }

  records.forEach((record, index) => {
    if (index > 0) lines.push("");
    lines.push(
      `## Papercut ${index + 1}`,
      "",
      `- Created: ${inlineCode(new Date(record.createdAtMs).toISOString())}`,
      `- Source: ${inlineCode(record.source)}`,
    );
    if (record.repo !== null) {
      lines.push(`- Repository: ${inlineCode(record.repo.displayName)}`);
      if (record.repo.branch !== null) {
        lines.push(`- Branch: ${inlineCode(record.repo.branch)}`);
      }
      lines.push(`- Working directory: ${inlineCode(record.repo.cwdRelative)}`);
    }
    if (record.model !== null) {
      lines.push(`- Model: ${inlineCode(record.model)}`);
    }
    if (record.category !== null) {
      lines.push(`- Category: ${inlineCode(record.category)}`);
    }
    if (record.tags.length > 0) {
      lines.push(`- Tags: ${record.tags.map(inlineCode).join(", ")}`);
    }
    lines.push("", fencedBody(record.body));
  });

  return `${lines.join("\n")}\n`;
}

function renderScope(scope: ScopeDescriptor): string {
  return scope.kind === "all"
    ? "all repositories"
    : `current repository ${inlineCode(scope.repository.name)}`;
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

function fencedBody(body: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
  const separator = body.endsWith("\n") ? "" : "\n";
  return `${fence}\n${body}${separator}${fence}`;
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
