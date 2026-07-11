# Papercuts CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested personal `papercuts` CLI that safely records agent friction in a central SQLite store, provides repository-aware views and exports, and installs opt-in Codex and Claude Code guidance.

**Architecture:** A dependency-light Bun/TypeScript modular monolith. SQLite is the only authoritative store; capture redacts before persistence; Git context and harness setup live behind explicit interfaces; Markdown and JSON are generated views. There is no daemon or network component.

**Tech Stack:** Bun 1.3+, TypeScript with strict checking, `bun:sqlite`, `bun:test`, Node-compatible filesystem/crypto/process APIs, Git CLI for read-only repository discovery.

**Priority:** P1
**Effort:** L
**Risk:** Medium, concentrated in capture-time redaction, SQLite migration/concurrency, and instruction-file mutation
**Planned at:** commit `841e34c`, 2026-07-10
**Design source:** `docs/superpowers/specs/2026-07-10-papercuts-cli-design.md`

## Global Constraints

- Runtime dependencies are zero unless a safety requirement cannot be met with Bun or Node-compatible built-ins.
- The writable database is always external at `~/Library/Application Support/papercuts/papercuts.sqlite3` by default; `PAPERCUTS_HOME` overrides its parent directory.
- The data directory is mode `0700`; database and owned instruction files are mode `0600`.
- The only capture sources are `manual`, `codex`, `claude-code`, and `generic`.
- Only the observation body is required. Model, category, and tags are optional, length-bounded, and redacted.
- Observation bodies are immutable and limited to 65,536 UTF-8 bytes.
- Redaction occurs before persistence, diagnostics, JSON formatting, or export. No raw backup or bypass exists.
- `bun:sqlite` is imported only from `src/storage/**`, every connection uses strict bindings, and migrations refuse future schemas without mutation.
- Harness setup is zero-write by default and mutates only with `--apply`; undo also previews unless combined with `--apply`.
- Generic setup prints a snippet and rejects `--apply`.
- Agent capture uses stdin, never echoes the submitted body, and must not block the primary agent task on failure.
- JSON mode emits exactly one versioned object plus newline and no ANSI/prose.
- No transcript mining, cloud sync, daemon, semantic analysis, issue workflow, TUI, dynamic plugin system, or public distribution work.
- Every production behavior follows TDD: observe a focused test fail for the expected reason before implementing it.
- One integrator owns shared manifests, domain contracts, entrypoint/command registry, README, and cross-module acceptance tests.

---

## Current state and commands

At planned commit `841e34c`, the repository contains only `.gitignore` and the approved design specification. There is no source tree, package manifest, dependency lockfile, build, or test baseline. Task 1 establishes that baseline before any parallel implementation begins.

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 and lockfile unchanged after the first install |
| Focused tests | `bun test <test-path>` | named tests pass with no warnings |
| Full tests | `bun test` | all tests pass with no warnings |
| Typecheck | `bun run typecheck` | exit 0 with no diagnostics |
| Compile | `bun run build` | exit 0 and `dist/papercuts` is executable |
| Complete gate | `bun run check` | typecheck, tests, and compiled build all succeed |

## Git workflow

- Integration branch: `feature/papercuts-cli`.
- Parallel tasks use isolated branches/worktrees created from the reviewed Task 1 commit.
- Each task commits only its exclusive files with the commit subject specified in that task.
- Review and integrate each task before deleting its worktree.
- Do not push or create a pull request; this repository is local-only unless the operator later says otherwise.

---

## File ownership and execution waves

The integration branch is `feature/papercuts-cli`.

Wave 1 is Task 1. After it is reviewed and committed, Tasks 2, 3, and 4 run concurrently in isolated worktrees because their source and test paths do not overlap. Task 5 follows Task 2. Task 6 integrates Tasks 2–5. Task 7 performs cross-module acceptance work and documentation.

| Task | Exclusive ownership | Depends on |
|---|---|---|
| 1 | manifest, lockfile, TypeScript config, domain/error contracts, redactor, shared platform primitives | none |
| 2 | `src/storage/**`, `test/storage/**` | 1 |
| 3 | `src/repository/**`, `src/capture/**`, matching tests | 1 |
| 4 | `src/setup/**`, `test/setup/**` | 1 |
| 5 | `src/views/**`, `test/views/**` | 1, 2 interfaces |
| 6 | `src/cli/**`, `src/doctor/**`, `src/index.ts`, matching tests | 1–5 |
| 7 | acceptance tests, README, final scripts and verification | 1–6 |

## Shared interfaces

Task 1 must publish these names from `src/domain/types.ts`; later tasks consume them without renaming:

```ts
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
  health(): StoreHealth;
  close(): void;
}
```

`src/domain/errors.ts` must export code-driven `PapercutsError`. Its constructor accepts only `internal_error`, `invalid_input`, `not_found`, `setup_conflict`, `store_busy`, or `safety_failure`; a frozen internal registry derives the fixed message, exit code 1–6, and retryability. Callers cannot supply a message, details, raw payload, or cause.

---

### Task 1: Project foundation, domain contracts, and redaction

**Files:**
- Create: `package.json`
- Create: `bun.lock`
- Create: `tsconfig.json`
- Create: `src/domain/types.ts`
- Create: `src/domain/errors.ts`
- Create: `src/security/redactor.ts`
- Create: `src/platform/hash.ts`
- Create: `src/platform/paths.ts`
- Create: `src/platform/process.ts`
- Create: `src/platform/private-files.ts`
- Create: `test/security/redactor.test.ts`
- Create: `test/domain/errors.test.ts`
- Create: `test/platform/hash.test.ts`
- Create: `test/platform/paths.test.ts`
- Create: `test/platform/private-files.test.ts`

**Interfaces:**
- Produces: all shared interfaces listed above, code-driven `PapercutsError`, `REDACTION_RULESET_VERSION`, `redact(raw: string): RedactionResult`, `normalizeScreenedTag(text: ScreenedText): ScreenedText`, `sha256Hex`, `resolvePapercutsPaths`, `ProcessRunner`, `bunProcessRunner`, and private-file helpers consumed by Tasks 2–4.
- Consumes: only Bun/Node-compatible built-ins.

- [ ] **Step 1: Establish the Bun project and verification scripts**

Create a private ESM package named `papercuts` at version `0.1.0`. Add development dependencies with `bun add --dev typescript @types/bun` and commit the generated lockfile. Preserve these fields when Bun updates the manifest:

```json
{
  "name": "papercuts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "papercuts": "src/index.ts"
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "build": "bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile dist/papercuts src/index.ts",
    "check": "bun run typecheck && bun test && bun run build"
  },
  "engines": {
    "bun": ">=1.3.0"
  }
}
```

Configure TypeScript for ESNext modules, strict checking, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and Bun types. Do not create `src/index.ts` yet; Task 6 owns it, so `bun run build` is expected to fail until Task 6.

- [ ] **Step 2: Write failing redactor tests**

Cover synthetic examples for authorization headers, cookie values, private-key blocks, credential-bearing URLs, secret-named assignments, and recognized credential prefixes. Credential-prefix cases must include synthetic values constructed in the test, such as `"ghp_" + "A".repeat(24)` and `"sk-" + "B".repeat(24)`, and assert `[REDACTED:CREDENTIAL]`. Cover false-positive preservation for short lookalikes, ordinary prose, paths, commit hashes, and non-secret key names. Assert idempotency and typed class-only replacements. Include a long near-match that completes promptly.

Use this table-test shape so each class is proven independently:

```ts
for (const [raw, marker] of [
  [`Authorization: Bearer ${"A".repeat(32)}`, "[REDACTED:AUTHORIZATION]"],
  [`Cookie: session=${"B".repeat(32)}`, "[REDACTED:COOKIE]"],
  [`https://user:${"C".repeat(24)}@example.test/repo`, "[REDACTED:URL_CREDENTIAL]"],
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
```

Run: `bun test test/security/redactor.test.ts`

Expected: FAIL because `src/security/redactor.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure redactor**

Export:

```ts
export const REDACTION_RULESET_VERSION = "1";
export function redact(raw: string): RedactionResult;
```

Use small independent regular expressions without nested ambiguous repetition. Replace matches with `[REDACTED:CREDENTIAL]`, `[REDACTED:AUTHORIZATION]`, `[REDACTED:COOKIE]`, `[REDACTED:PRIVATE_KEY]`, `[REDACTED:URL_CREDENTIAL]`, or `[REDACTED:SECRET]`. Secret-named assignments use a bounded linear logical-line scanner that consumes quoted/unquoted concatenation and continuations. Count replacements and brand the returned text as `ScreenedText`. Never retain the matched value. Export only `normalizeScreenedTag`, which performs trim plus lowercase on an already-screened tag and accepts no callback or arbitrary replacement text.

The credential-prefix matcher must, at minimum, recognize these conservative forms without matching their short lookalikes:

```ts
const CREDENTIAL_PREFIXES = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
] as const;
```

Run: `bun test test/security/redactor.test.ts`

Expected: all redactor tests pass with clean output.

- [ ] **Step 4: Write failing code-driven error tests, then add the domain contracts**

Write `test/domain/errors.test.ts` first. Assert all six code-to-message/exit/retry mappings and use `@ts-expect-error` to prove a second/message argument is rejected. Observe RED because the class is missing. Then create the shared interfaces verbatim and implement the closed frozen registry. `toJSON` emits only code, fixed message, exit code, and retryability.

Run: `bun test test/domain/errors.test.ts && bun run typecheck`

Expected: all error tests pass and typecheck exits 0.

- [ ] **Step 5: Write failing platform-boundary tests**

Test SHA-256 hex output, macOS default and `PAPERCUTS_HOME` path resolution, rejection of relative overrides, owner-only directory/file mode correction, and path-component symlink detection. The process contract is typechecked here and exercised with real Git commands in Task 3.

Run: `bun test test/platform`

Expected: FAIL because the platform modules do not exist.

- [ ] **Step 6: Implement the frozen platform primitives**

Use these contracts:

```ts
export function sha256Hex(input: string | Uint8Array): string;
export function resolvePapercutsPaths(input: {
  home: string;
  papercutsHome?: string;
}): { dataDir: string; databasePath: string };
export interface ProcessResult { exitCode: number; stdout: string; stderr: string }
export interface ProcessRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<ProcessResult>;
}
export const bunProcessRunner: ProcessRunner;
export function ensurePrivateDirectorySync(path: string): void;
export function ensurePrivateFileSync(path: string): void;
export async function assertPathHasNoSymlinkComponents(
  canonicalScopeRoot: string,
  targetPath: string,
): Promise<void>;
```

`bunProcessRunner` must call `Bun.spawn` with an argv array and never a shell. The two permission helpers use synchronous filesystem calls so the synchronous SQLite store can enforce modes before returning and immediately after a write. Path resolution treats `PAPERCUTS_HOME` as the data directory itself, so its database is `<PAPERCUTS_HOME>/papercuts.sqlite3`.

Run: `bun test test/platform && bun run typecheck`

Expected: all platform tests pass and typecheck exits 0.

- [ ] **Step 7: Commit Task 1**

Run: `bun test && bun run typecheck`

Expected: all tests pass and typecheck exits 0.

Commit: `feat: establish papercuts domain and redaction`

---

### Task 2: SQLite store and migrations

**Files:**
- Create: `src/storage/migrations.ts`
- Create: `src/storage/sqlite-store.ts`
- Create: `test/storage/sqlite-store.test.ts`
- Create: `test/storage/migrations.test.ts`

**Interfaces:**
- Consumes: `Papercut`, `PapercutQuery`, `PapercutStore`, `ScreenedText`, `PapercutsError`, and Task 1 private-file helpers.
- Produces: `openSqliteStore(path: string): PapercutStore` and `CURRENT_SCHEMA_VERSION`.

- [ ] **Step 1: Write failing store behavior tests**

Using a temporary directory, assert a fresh store creates the schema, appends and lists full records, filters by repository and inclusive `sinceMs`, orders ties by `(created_at_ms, id)`, respects limits, round-trips nullable Git metadata and optional fields, and reports health with integrity `"ok"`, schema version 1, a non-empty SQLite version, and an available write lock.

Run: `bun test test/storage/sqlite-store.test.ts`

Expected: FAIL because the store module does not exist.

- [ ] **Step 2: Define and apply the strict schema**

Migration 1 uses this schema verbatim:

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms > 0)
) STRICT;

CREATE TABLE papercuts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) BETWEEN 1 AND 65536),
  source TEXT NOT NULL CHECK (source IN ('manual','codex','claude-code','generic')),
  model TEXT,
  category TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  client_version TEXT NOT NULL,
  repo_key TEXT CHECK (repo_key IS NULL OR length(repo_key) = 64),
  repo_key_kind TEXT CHECK (repo_key_kind IS NULL OR repo_key_kind IN ('local','remote')),
  repo_name TEXT,
  repo_root TEXT,
  cwd_rel TEXT,
  branch TEXT,
  head TEXT,
  redaction_count INTEGER NOT NULL CHECK (redaction_count >= 0),
  redaction_version TEXT NOT NULL,
  CHECK (
    (repo_key IS NULL AND repo_key_kind IS NULL AND repo_name IS NULL
      AND repo_root IS NULL AND cwd_rel IS NULL AND branch IS NULL AND head IS NULL)
    OR
    (repo_key IS NOT NULL AND repo_key_kind IS NOT NULL AND repo_name IS NOT NULL
      AND repo_root IS NOT NULL AND cwd_rel IS NOT NULL)
  )
) STRICT;

CREATE INDEX papercuts_created_idx
  ON papercuts(created_at_ms DESC, id DESC);
CREATE INDEX papercuts_repo_created_idx
  ON papercuts(repo_key, created_at_ms DESC, id DESC)
  WHERE repo_key IS NOT NULL;
```

`openSqliteStore` must use `new Database(path, { create: true, strict: true })`, then configure WAL, foreign keys, `synchronous=FULL`, and a 2000 ms busy timeout. Use Task 1 synchronous private-file helpers to enforce `0700` on the parent and `0600` on the database plus existing `-wal` and `-shm` sidecars after WAL initialization and immediately after each append.

Run: `bun test test/storage/sqlite-store.test.ts`

Expected: all store behavior tests pass.

- [ ] **Step 3: Write failing migration safety tests**

Assert migration checksums are persisted, reopening is idempotent, two concurrent openers result in one applied migration, a programmatically created schema-v0 fixture upgrades to migration 1, a checksum mismatch fails without mutation, and a synthetic future schema is refused without mutation. Hold `BEGIN IMMEDIATE` from a second connection and assert `health().lockAvailable === false`; after rollback it becomes true. Assert database, WAL, and SHM modes are `0600` after a write.

Run: `bun test test/storage/migrations.test.ts`

Expected: at least the future-schema and checksum tests fail before safety handling is implemented.

- [ ] **Step 4: Implement serialized checked migrations and busy errors**

Apply pending migrations under `BEGIN IMMEDIATE`, verify every already-applied checksum, and roll back on failure. Convert SQLite busy/locked outcomes into sanitized `PapercutsError` code `store_busy`, exit 5, retryable true. Never include SQL parameter values in error text.

Run: `bun test test/storage`

Expected: all storage and migration tests pass.

- [ ] **Step 5: Commit Task 2**

Run: `bun test test/storage && bun run typecheck`

Expected: all storage tests pass and typecheck exits 0.

Commit: `feat: add durable SQLite papercut store`

---

### Task 3: Repository attribution and capture service

**Files:**
- Create: `src/repository/remote.ts`
- Create: `src/repository/context.ts`
- Create: `src/capture/service.ts`
- Create: `test/repository/remote.test.ts`
- Create: `test/repository/context.test.ts`
- Create: `test/capture/service.test.ts`

**Interfaces:**
- Consumes: Task 1 domain types, redaction/screened-text helpers, hashing/process contracts, and a supplied `PapercutStore`.
- Produces: `normalizeRemote(raw: string): string | null`, `resolveRepoContext(cwd: string): Promise<ResolvedRepoContext | null>`, and `createCaptureService(dependencies)` returning a safe receipt with no body.

Use these exact service contracts:

```ts
export interface CaptureInput {
  body: string;
  source: CaptureSource;
  model?: string;
  category?: string;
  tags?: readonly string[];
  cwd: string;
}

export interface CaptureServiceDependencies {
  store: PapercutStore;
  resolveRepoContext(cwd: string): Promise<ResolvedRepoContext | null>;
  now(): number;
  randomUUID(): string;
  clientVersion: string;
}

export interface CaptureService {
  capture(input: CaptureInput): Promise<{
    receipt: CaptureReceipt;
    warnings: readonly string[];
  }>;
}
```

- [ ] **Step 1: Write failing remote normalization tests**

Assert equivalent HTTPS, `ssh://`, and SCP-style remotes normalize to the same credential-free host/path; lowercase hostnames and default ports normalize; path case is preserved; `.git`, query, fragment, password, token, and userinfo are removed before hashing. Ambiguous or malformed inputs return null without echoing the raw input.

The required normalization table is:

```ts
[
  ["https://user:pass@Example.COM/Owner/Repo.git?token=hidden#fragment", "example.com/Owner/Repo"],
  ["ssh://git@example.com:22/Owner/Repo.git", "example.com/Owner/Repo"],
  ["git@example.com:Owner/Repo.git", "example.com/Owner/Repo"],
  ["ssh://git@example.com:2222/Owner/Repo.git", "example.com:2222/Owner/Repo"],
]
```

Run: `bun test test/repository/remote.test.ts`

Expected: FAIL because `remote.ts` does not exist.

- [ ] **Step 2: Implement safe remote normalization**

Return only a canonical host/port/path string suitable for SHA-256 hashing. Do not export a helper that returns parsed credentials. Use Node-compatible URL and crypto APIs plus a small explicit SCP-style parser.

Run: `bun test test/repository/remote.test.ts`

Expected: all normalization tests pass.

- [ ] **Step 3: Write failing Git context tests**

Create temporary Git repositories and linked worktrees. Cover root/subdirectory discovery, shared worktree identity, sanitized remote identity across two clones, branch and full HEAD capture, detached HEAD, unborn branch, missing Git repository, and cwd-relative normalization. Remote selection tests must prove: `origin` wins when present; a sole non-`origin` remote is used; multiple non-`origin` remotes cause local fallback. Put credential-prefix and secret-assignment canaries separately in repository directory name, nested cwd, branch, and remote-derived display name. Assert returned `displayName`, `root`, `cwdRelative`, `branch`, and `head` are screened and raw canaries never appear in returned context or thrown errors. Assert a screened remote preimage falls back to the local device/inode key, and compare the persisted key to `sha256Hex("local:<dev>:<ino>")` so no secret-derived hash can pass silently.

Run: `bun test test/repository/context.test.ts`

Expected: FAIL because `context.ts` does not exist.

- [ ] **Step 4: Implement best-effort repository discovery**

Run Git without a shell through Task 1's `ProcessRunner`. Resolve the real worktree root and Git common directory. Read the common directory's device/inode and define local key `sha256Hex("local:<dev>:<ino>")`; never hash the path. Normalize and redact the selected remote preimage. Use `sha256Hex("remote:<screened-normalized-remote>")` only when remote screening made zero replacements; otherwise discard it and use the local key. Repository display name comes from the screened remote path or screened worktree basename. Redact display name, root, relative cwd, branch, and HEAD before constructing `RepoContext`; sum all repository replacements into `ResolvedRepoContext.redactionCount`. Return null for an ordinary non-Git directory. Redaction failure is fatal; other unexpected context failures are sanitized and may be downgraded by the capture service to an unscoped record with a warning.

Run: `bun test test/repository/context.test.ts`

Expected: all repository tests pass.

- [ ] **Step 5: Write failing capture service tests**

Use real redaction and an in-memory fake store. Cover required body, 65,536-byte boundary, rejection at 65,537 bytes, source validation, optional model/category/tags, tag normalization/deduplication, redaction across every persisted string, injected clock/UUID, scoped and unscoped records, and repository-warning fallback. Inspect the fake store to prove every persisted string derived from observation or Git context is screened. Separately assert the returned receipt contains ID/time/source/repository name/redaction count and cannot contain body, root, key, model, category, or tags.

Run: `bun test test/capture/service.test.ts`

Expected: FAIL because `service.ts` does not exist.

- [ ] **Step 6: Implement capture orchestration**

Validate bounds before regular expressions. Allow at most 16 tags; model max 256 bytes; category and each tag max 64 bytes. Redact body and every optional string separately before normalization. Use Task 1 `normalizeScreenedTag` to trim and lowercase already-screened tags, then remove duplicates and stable-sort them. Sum observation replacements with `ResolvedRepoContext.redactionCount`, generate a UUIDv4 and timestamp through injected functions, append once, and return only a `CaptureReceipt` plus sanitized warnings.

Run: `bun test test/capture test/repository`

Expected: all capture and repository tests pass.

- [ ] **Step 7: Commit Task 3**

Run: `bun test test/capture test/repository && bun run typecheck`

Expected: all focused tests pass and typecheck exits 0.

Commit: `feat: capture papercuts with repository context`

---

### Task 4: Preview-first harness setup

**Files:**
- Create: `src/setup/types.ts`
- Create: `src/setup/content.ts`
- Create: `src/setup/markers.ts`
- Create: `src/setup/adapters.ts`
- Create: `src/setup/applier.ts`
- Create: `test/setup/content.test.ts`
- Create: `test/setup/markers.test.ts`
- Create: `test/setup/adapters.test.ts`
- Create: `test/setup/applier.test.ts`

**Interfaces:**
- Consumes: `PapercutsError`, filesystem/crypto built-ins, and explicit `home`, `cwd`, and environment inputs.
- Produces: `planSetup(request): Promise<SetupPlan>`, `applySetup(plan): Promise<void>`, and `renderGenericInstructions(): string`.

The public plan types are:

```ts
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
```

- [ ] **Step 1: Write failing instruction-content tests**

Assert Codex and Claude content includes proactive one-or-two-sentence logging, stdin use with the correct source, once-per-distinct-issue guidance, secret/raw-output avoidance, accomplishments/bugs distinction, primary-task continuation, no recursive capture-failure logging, and no automatic transcript review.

Run: `bun test test/setup/content.test.ts`

Expected: FAIL because `content.ts` does not exist.

- [ ] **Step 2: Implement deterministic instruction templates**

Use versioned markers `<!-- papercuts:begin v1 -->` and `<!-- papercuts:end -->`. Template functions are pure and deterministic.

Run: `bun test test/setup/content.test.ts`

Expected: content tests pass.

- [ ] **Step 3: Write failing marker-parser tests**

Write cases for absent, one valid block, duplicate blocks, missing begin/end, reversed markers, and nesting.

Run: `bun test test/setup/markers.test.ts`

Expected: FAIL because `markers.ts` does not exist.

- [ ] **Step 4: Implement the marker parser**

Implement the smallest parser that identifies an absent or one valid block and rejects every malformed state with a sanitized setup conflict.

Run: `bun test test/setup/markers.test.ts`

Expected: all marker tests pass.

- [ ] **Step 5: Write failing adapter planning tests**

Use fixture home/repository trees. Verify Codex user scope resolves `CODEX_HOME` and active `AGENTS.override.md` precedence; otherwise targets `AGENTS.md`. Verify Codex repo scope uses a non-empty root `AGENTS.override.md` first and otherwise root `AGENTS.md`. Verify Claude targets the adapter-owned user or repo rules file. Verify generic returns a snippet and no mutation. Every plan retains its `SetupScope` and canonical scope root. Install/remove previews must not create any directory, database, lock, cache, or target file.

Run: `bun test test/setup/adapters.test.ts`

Expected: FAIL because adapters do not exist.

- [ ] **Step 6: Implement pure setup planning**

Read only the target files required to create an ephemeral plan. Managed diffs contain only generated lines and target/action metadata, never unrelated instruction content. Generic apply requests are represented as a conflict so the CLI can reject them.

Run: `bun test test/setup/adapters.test.ts`

Expected: all adapter planning tests pass and fixture trees remain byte-identical.

- [ ] **Step 7: Write failing atomic apply tests**

Cover first apply, identical reapply, upgrade of an older managed block, remove preview, remove apply, preservation of surrounding bytes/newline/mode, adapter-owned file deletion, preimage drift, target and parent-directory symlinks, non-regular-file refusal, malformed markers, scope escape, and two concurrent papercuts applies. Inject a mutation after temp-file flush but before the final preimage check and assert conflict with no rename. Assert failures leave the fixture tree unchanged; the scope-root lock must always be removed in `finally`.

Run: `bun test test/setup/applier.test.ts`

Expected: FAIL before `applier.ts` exists.

- [ ] **Step 8: Implement safe apply and undo**

Validate the target is lexically within `canonicalScopeRoot`, then use Task 1's path-component walker to reject symlinked parents and targets. Acquire `<canonicalScopeRoot>/.papercuts-setup-<first-16-hex-of-target-sha256>.lock` with exclusive creation so cooperating setup processes serialize even when the target parent does not exist. Recheck scope components and the target SHA-256, create target directories only during apply with mode `0700`, write a same-directory exclusive temporary file at `0600`, flush it, then recheck scope components and target SHA-256 again immediately before atomic rename. Preserve an existing target's mode, flush the parent directory, and remove lock/temp files in `finally`. Delete only an entirely adapter-owned file. Convert conflicts into sanitized exit-4 `PapercutsError` values. Document that this is cooperative concurrency protection plus a final preimage check; no portable filesystem API can provide compare-and-swap against an unrelated editor in the final rename instant.

Run: `bun test test/setup`

Expected: all setup tests pass with clean output.

- [ ] **Step 9: Commit Task 4**

Run: `bun test test/setup && bun run typecheck`

Expected: all setup tests pass and typecheck exits 0.

Commit: `feat: add safe harness setup adapters`

---

### Task 5: Repository views, statistics, and Markdown export

**Files:**
- Create: `src/views/stats.ts`
- Create: `src/views/human.ts`
- Create: `src/views/markdown.ts`
- Create: `test/views/stats.test.ts`
- Create: `test/views/human.test.ts`
- Create: `test/views/markdown.test.ts`

**Interfaces:**
- Consumes: immutable `Papercut` arrays from Task 1 and list results from Task 2.
- Produces: `summarize(records)`, `renderList(records, scopeLabel)`, `renderStats(summary, scopeLabel)`, and `renderMarkdown(records, scopeLabel)`.

Use these result contracts:

```ts
export type ScopeDescriptor =
  | { kind: "all" }
  | { kind: "current"; repository: { name: string } };
export interface StatsSummary {
  total: number;
  firstAt: string | null;
  lastAt: string | null;
  byDay: Readonly<Record<string, number>>;
  bySource: Readonly<Record<string, number>>;
  byRepository: Readonly<Record<string, number>>;
  byCategory: Readonly<Record<string, number>>;
  redactedRecordCount: number;
  replacementCount: number;
  exactRepeats: readonly { body: string; count: number }[];
}
export function summarize(records: readonly Papercut[]): StatsSummary;
export function renderList(records: readonly Papercut[], scope: ScopeDescriptor): string;
export function renderStats(summary: StatsSummary, scope: ScopeDescriptor): string;
export function renderMarkdown(records: readonly Papercut[], scope: ScopeDescriptor): string;
```

- [ ] **Step 1: Write failing statistics tests**

Cover empty input, UTC day buckets, source/repository/category counts, `redactedRecordCount` (records whose replacement count is greater than zero), total `replacementCount`, exact repeated redacted bodies, stable lexical keys, and time range.

Run: `bun test test/views/stats.test.ts`

Expected: FAIL because `stats.ts` does not exist.

- [ ] **Step 2: Implement deterministic structural statistics**

Return plain readonly data. Do not infer topics, causes, priority, or remediation. Exact-repeat counts use the already-redacted body.

Run: `bun test test/views/stats.test.ts`

Expected: all stats tests pass.

- [ ] **Step 3: Write failing human and Markdown rendering tests**

Cover empty results, multiline bodies, Unicode, raw HTML, headings/front matter, and bodies containing backtick runs longer than the normal fence. Put hostile Markdown/HTML/backtick canaries separately in repository display name, branch, relative cwd, model, category, and tags. Assert every metadata canary is rendered inert, exports omit absolute roots and repository fingerprints, and output remains byte-identical for the same input.

Run: `bun test test/views/human.test.ts test/views/markdown.test.ts`

Expected: FAIL because rendering modules do not exist.

- [ ] **Step 4: Implement safe deterministic renderers**

Human list output uses readable timestamp/source/repository metadata and the full redacted body. Markdown uses a dynamically longer backtick fence than any body run. Render every metadata string through an inline-code helper that chooses a delimiter longer than the input's longest backtick run and escapes `<`, `>`, and `&` before interpolation. Include safe repo display name, branch, relative cwd, model, category, and tags only when present. Do not include generation time.

Run: `bun test test/views`

Expected: all view tests pass.

- [ ] **Step 5: Commit Task 5**

Run: `bun test test/views && bun run typecheck`

Expected: all view tests pass and typecheck exits 0.

Commit: `feat: add papercut views and Markdown export`

---

### Task 6: CLI orchestration and doctor

**Files:**
- Create: `src/cli/args.ts`
- Create: `src/cli/input.ts`
- Create: `src/cli/output.ts`
- Create: `src/cli/run.ts`
- Create: `src/doctor/checks.ts`
- Create: `src/index.ts`
- Create: `test/cli/args.test.ts`
- Create: `test/cli/input.test.ts`
- Create: `test/cli/output.test.ts`
- Create: `test/cli/run.test.ts`
- Create: `test/doctor/checks.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 public functions.
- Produces: executable command surface, `runCli(argv, runtime): Promise<number>`, `readBoundedStdin(stream, maxBytes)`, and `runDoctor(context)`.

Use these orchestration contracts:

```ts
export interface CliIo {
  stdin: AsyncIterable<Uint8Array>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  stdoutIsTty: boolean;
}
export interface CliEnvironment {
  cwd: string;
  home: string;
  papercutsHome?: string;
  codexHome?: string;
  pathValue?: string;
}
export interface CliRuntime {
  io: CliIo;
  environment: CliEnvironment;
  openStore(path: string): PapercutStore;
  resolveRepoContext(cwd: string): Promise<ResolvedRepoContext | null>;
  planSetup(request: SetupRequest): Promise<SetupPlan>;
  applySetup(plan: SetupPlan): Promise<void>;
  now(): number;
  randomUUID(): string;
  clientVersion: string;
  runtimeVersion: string;
}
export function runCli(argv: readonly string[], runtime: CliRuntime): Promise<number>;
```

The parser returns this discriminated union; optional `json` exists on every variant:

```ts
export type ParsedCommand =
  | { kind: "help"; topic?: string; json: boolean }
  | { kind: "version"; json: boolean }
  | {
      kind: "add";
      text?: string;
      stdin: boolean;
      source: CaptureSource;
      model?: string;
      category?: string;
      tags: readonly string[];
      json: boolean;
    }
  | {
      kind: "list";
      repo: "auto" | "current" | "all";
      sinceMs?: number;
      limit: number;
      json: boolean;
    }
  | {
      kind: "stats";
      repo: "auto" | "current" | "all";
      sinceMs?: number;
      json: boolean;
    }
  | {
      kind: "export";
      repo: "auto" | "current" | "all";
      sinceMs?: number;
      output?: string;
      force: boolean;
      json: boolean;
    }
  | {
      kind: "setup";
      harness: Harness;
      scope: "user" | "repo";
      undo: boolean;
      apply: boolean;
      json: boolean;
    }
  | { kind: "doctor"; json: boolean };
```

JSON outputs use these exact top-level fields:

```ts
type JsonSuccess<T> = {
  version: 1;
  ok: true;
  command: string;
  data: T;
  warnings: readonly string[];
};
type JsonFailure = {
  version: 1;
  ok: false;
  command: string;
  error: { code: string; message: string; retryable: boolean };
};
```

Command `data` shapes are copied verbatim from the design's “Command data shapes” list; no command may invent extra payload fields. In particular, add maps internal `createdAtMs` to RFC 3339 UTC field `createdAt`; it does not serialize `CaptureReceipt` verbatim. JSON help returns `{topic, usage}` and JSON version returns `{version}`.

- [ ] **Step 1: Write failing parser tests for the complete command surface**

Cover every command and flag from the design, global flags before/after commands, conflicting positional/stdin input, source/model/category/tag validation, duration forms `m`, `h`, and `d`, list limit 1–1000 with default 50, repository defaults inside/outside Git, setup user default, and generic `--apply` rejection.

Run: `bun test test/cli/args.test.ts`

Expected: FAIL because `args.ts` does not exist.

- [ ] **Step 2: Implement dependency-free argument parsing**

Return a discriminated command union. Help and version parsing must not resolve the data path or open SQLite. Expected validation failures are `PapercutsError` exit 2.

Run: `bun test test/cli/args.test.ts`

Expected: all parser tests pass.

- [ ] **Step 3: Write failing bounded-input and output-contract tests**

Use chunked streams to prove stdin stops at 65,537 bytes, decodes UTF-8 fatally, rejects NULs, and never echoes rejected bytes. Assert JSON success/error is exactly one object and newline with no ANSI; add success contains only the fixed `CaptureReceipt` fields. Assert list/stats/export include the fixed resolved-scope object. Assert human errors go to stderr and JSON handled errors leave stderr empty.

Run: `bun test test/cli/input.test.ts test/cli/output.test.ts`

Expected: FAIL before input/output modules exist.

- [ ] **Step 4: Implement bounded stdin and stable output envelopes**

Use incremental byte counting before `TextDecoder` with `{ fatal: true }`. The JSON schema is `{version:1, ok, command, data?, warnings?, error?}`. Map sanitized errors to the stable exit codes from the design.

Run: `bun test test/cli/input.test.ts test/cli/output.test.ts`

Expected: all input/output tests pass.

- [ ] **Step 5: Write failing command-orchestration tests**

Inject a fake store factory, repository resolver, setup planner/applier, clock, and I/O. Cover add/list/stats/export/setup/doctor; current/all scope behavior; atomic output overwrite refusal and `--force`; setup preview zero writes and apply routing; and close-on-success/error. Use a counted `openStore` fake to prove SQLite is not opened for help, version, setup preview, empty input, NUL input, malformed UTF-8, oversized input, invalid source/model/category/tag, or generic `--apply`.

Run: `bun test test/cli/run.test.ts`

Expected: FAIL because `run.ts` does not exist.

- [ ] **Step 6: Implement command orchestration and the executable entrypoint**

Resolve `PAPERCUTS_HOME` without reading `.env`. Route help, version, and setup preview before store initialization. Open the external store lazily for data commands. `src/index.ts` passes `Bun.argv.slice(2)` to `runCli` and exits with the returned code without printing unhandled payloads.

Run: `bun test test/cli/run.test.ts`

Expected: all command tests pass.

- [ ] **Step 7: Write failing doctor tests**

Cover PATH discovery, CLI and Bun/compiled runtime version, external data path, directory/database mode and current owner versus expected owner, SQLite version, schema/integrity, write-lock availability, current Git attribution, adapter states and shadowing, and unavailable resources. Assert record bodies, raw remotes, environment values, and instruction content never appear. Assert the result is the fixed `{ok, checks}` structure from the design.

Run: `bun test test/doctor/checks.test.ts`

Expected: FAIL because `checks.ts` does not exist.

- [ ] **Step 8: Implement safe doctor checks**

Use `PapercutStore.health()` for SQLite version, schema, integrity, and cooperative write-lock status. Use filesystem metadata for mode/uid checks and report path names but never file contents. Each check returns `{name, status, message}` with a sanitized fixed-purpose message.

Run: `bun test test/doctor/checks.test.ts`

Expected: all doctor tests pass.

- [ ] **Step 9: Commit Task 6**

Run: `bun test && bun run typecheck && bun run build`

Expected: all tests pass, typecheck exits 0, and `dist/papercuts --version` prints `0.1.0`.

Commit: `feat: expose the papercuts CLI`

---

### Task 7: Black-box acceptance gates and user documentation

**Files:**
- Create: `test/acceptance/secret-boundary.test.ts`
- Create: `test/acceptance/concurrent-first-use.test.ts`
- Create: `test/acceptance/compiled-binary.test.ts`
- Create: `test/acceptance/setup-safety.test.ts`
- Create: `test/acceptance/repository-views.test.ts`
- Create: `README.md`
- Modify only if required by acceptance behavior: files already owned by Tasks 1–6

**Interfaces:**
- Consumes: the compiled CLI and all public behavior.
- Produces: release evidence and testing instructions for the user.

- [ ] **Step 1: Write the secret-boundary acceptance test**

Generate unique synthetic canaries for every supported secret class, including all three credential-prefix families from Task 1. Add via stdin, then inspect stdout/stderr, SQLite query results, database/WAL/SHM bytes, doctor output, and Markdown export. No raw canary may appear. The test must use only synthetic credentials and must assert each expected class marker appears in the queried redacted body so an omitted matcher cannot make the test vacuously pass.

Run: `bun test test/acceptance/secret-boundary.test.ts`

Expected: PASS on the integrated implementation; any leak is a release blocker and must be fixed with a focused failing regression test.

- [ ] **Step 2: Write concurrent first-use and compiled persistence tests**

Launch fifty CLI processes against a nonexistent temporary `PAPERCUTS_HOME`, assert fifty records, schema version 1, owner-only database/WAL/SHM modes, and `integrity_check=ok`, and tolerate no unhandled busy error. Build the standalone executable, run it with Bun and Node removed from `PATH`, and prove add/list/export persist across separate invocations.

Run: `bun test test/acceptance/concurrent-first-use.test.ts test/acceptance/compiled-binary.test.ts`

Expected: both acceptance suites pass.

- [ ] **Step 3: Write setup and repository black-box tests**

Assert setup preview leaves the entire fixture tree unchanged and creates no application directory; apply/reapply/undo is byte-safe; symlinks and drift fail without mutation. Exercise repositories, subdirectories, linked worktrees, separate clones, credential-bearing remotes, and non-Git directories through the CLI and verify filtering/export.

Run: `bun test test/acceptance/setup-safety.test.ts test/acceptance/repository-views.test.ts`

Expected: both suites pass.

- [ ] **Step 4: Write the user README**

Document the purpose and papercut definition, prerequisites, `bun install`, development commands, standalone build, `./dist/papercuts` smoke test, optional `bun link`, every command with examples, JSON mode, central data location, privacy/redaction limits, setup preview/apply/undo, and deferred transcript review. Include the dogfood zsh example: assigning to lowercase `path` changes zsh's command-search path and can cause later commands to appear missing.

- [ ] **Step 5: Run the full release gate**

Run:

```bash
bun run typecheck
bun test
bun run build
env -i HOME="$HOME" PATH="/usr/bin:/bin" PAPERCUTS_HOME="$(mktemp -d)" ./dist/papercuts --version
git diff --check
```

Expected: typecheck, all tests, compiled build, standalone version smoke test, and whitespace check exit 0 with clean output.

- [ ] **Step 6: Commit Task 7**

Commit: `test: verify papercuts end to end`

---

## Plan self-review checklist

- Every approved design requirement maps to a task above.
- No task may broaden setup targets or add transcript handling.
- Exact public type names are frozen before parallel work begins.
- Parallel tasks own disjoint files and integrate only after task-scoped review.
- A reviewer must inspect redaction, remote normalization, SQLite migrations, setup mutation, and acceptance tests rather than trusting test counts.

## STOP conditions

Stop and report instead of improvising if any of these occurs:

- An in-scope file changed after its task branch was created and the change conflicts with the frozen interfaces.
- A focused verification fails twice after one reasonable correction.
- A task needs a runtime dependency or a file owned by a different parallel task.
- Bun standalone compilation cannot preserve an external writable SQLite database.
- Strict SQLite bindings or the required durability pragmas are unavailable.
- Safe setup apply/undo would require printing, overwriting, or backing up unrelated instruction content.
- A synthetic secret canary reaches any persistent file or output and the leak cannot be covered by a focused failing regression test.
