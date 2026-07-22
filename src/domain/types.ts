export type CaptureSource = "manual" | "codex" | "claude-code" | "generic";
export type RepoKeyKind = "local" | "remote";
export type ScreenedText = string & { readonly __screened: unique symbol };

export interface RedactionResult {
  text: ScreenedText;
  replacementCount: number;
  rulesetVersion: string;
}

export interface RepoContext {
  key: string;
  keyKind: RepoKeyKind;
  displayName: ScreenedText;
  root: ScreenedText;
  cwdRelative: ScreenedText;
  branch: ScreenedText | null;
  head: ScreenedText | null;
}

export interface ResolvedRepoContext {
  context: RepoContext;
  redactionCount: number;
}

export interface Papercut {
  id: string;
  createdAtMs: number;
  body: ScreenedText;
  source: CaptureSource;
  model: ScreenedText | null;
  category: ScreenedText | null;
  tags: readonly ScreenedText[];
  clientVersion: string;
  repo: RepoContext | null;
  redactionCount: number;
  redactionVersion: string;
}

export interface PapercutQuery {
  repoKey?: string;
  sinceMs?: number;
  order: "newest" | "oldest";
  limit?: number;
  includeResolved?: true;
}

export interface StoreHealth {
  schemaVersion: number;
  integrity: string;
  sqliteVersion: string;
  lockAvailable: boolean;
}

export interface CaptureReceipt {
  id: string;
  createdAtMs: number;
  source: CaptureSource;
  repository: { name: ScreenedText } | null;
  redactionCount: number;
}

export interface PapercutStore {
  append(record: Papercut): void;
  list(query: PapercutQuery): readonly Papercut[];
  setResolved(id: string, resolvedAtMs: number | null): boolean;
  health(): StoreHealth;
  close(): void;
}
