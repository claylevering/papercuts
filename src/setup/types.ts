export type Harness = "codex" | "claude-code" | "generic";

export type SetupScope = { kind: "user" } | { kind: "repo"; root: string };

export interface SetupRequest {
  harness: Harness;
  action: "install" | "remove";
  scope: SetupScope;
  home: string;
  codexHome?: string;
}

export interface PlannedFileMutation {
  path: string;
  expectedSha256: string | null;
  nextContent: string | null;
  createMode: number;
  managedDiff: readonly string[];
}

export interface SetupPlan {
  harness: Harness;
  action: "install" | "remove";
  scope: SetupScope;
  canonicalScopeRoot: string;
  state: "absent" | "current" | "outdated" | "conflict";
  mutations: readonly PlannedFileMutation[];
  snippet?: string;
}
