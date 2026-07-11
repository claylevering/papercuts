import type { CaptureSource } from "../domain/types";

export const BEGIN_MARKER = "<!-- papercuts:begin v1 -->";
export const END_MARKER = "<!-- papercuts:end -->";

function renderInstructions(source: CaptureSource): string {
  return [
    BEGIN_MARKER,
    "## Papercuts",
    "",
    "- proactively record small, concrete friction you encounter while working, without asking first.",
    "Use one or two sentences: say what you were doing, what got in the way, and optionally a suspected cause or fix.",
    "Record each distinct issue at most once per task.",
    "Never include secrets, raw transcripts, or large command output.",
    "A papercut is not an accomplishment log and not a tracked bug; keep using the project's normal issue workflow for bugs.",
    `Pipe the observation to \`papercuts add --stdin --source ${source}\`.`,
    "If capture fails, continue the primary task.",
    "Never record a papercuts capture failure as another papercut.",
    "Never review transcripts automatically.",
    END_MARKER,
  ].join("\n");
}

export function renderCodexInstructions(): string {
  return renderInstructions("codex");
}

export function renderClaudeInstructions(): string {
  return renderInstructions("claude-code");
}

export function renderGenericInstructions(): string {
  return renderInstructions("generic");
}
