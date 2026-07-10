# Papercuts CLI Design

**Status:** Approved
**Date:** 2026-07-10
**Audience:** Personal local use on macOS, with Codex, Claude Code, and generic agent harnesses

## Objective

Build a friendly local `papercuts` CLI that lets coding agents proactively record small, non-blocking workflow friction while continuing their primary task. The accumulated observations should make recurring harness, repository, documentation, shell, and tooling problems visible without dirtying project working trees.

A papercut is not an accomplishment log or an issue tracker. It is a concise observation such as a dead-end tool call, stale cache, broken link, misleading error, flaky command, undocumented setup step, or non-obvious gotcha.

## Success criteria

- An agent can record a useful observation with one non-interactive command.
- Only the observation text is required; trustworthy context is captured automatically.
- Records live in one private central store and can be filtered by the current repository.
- Human output is pleasant, while `--json` is stable and automation-safe.
- Markdown exports are deterministic and do not modify repositories unless an explicit output path is requested.
- Codex and Claude Code setup is preview-first, opt-in, reversible, and safe around existing instructions.
- High-confidence credentials are redacted before any record reaches disk or diagnostic output.
- Concurrent agents cannot lose or partially write records.
- A compiled standalone executable continues using an external persistent database.

## Chosen approach

Use Bun, TypeScript, and Bun's built-in SQLite implementation. Development uses Bun directly. A standalone binary is produced with `bun build --compile`; no application architecture changes are required for compilation.

SQLite is the only authoritative store. Markdown and JSON are generated views, not parallel data stores. The CLI has no daemon, network service, cloud dependency, account system, or background watcher.

Runtime dependencies should remain zero unless a requirement cannot be implemented safely with Bun and Node-compatible built-ins. Development dependencies may include TypeScript and Bun type definitions.

## Architecture

The application is a modular monolith with narrow boundaries:

- `cli`: argument parsing, help, command routing, stable exit codes, and human/JSON output.
- `capture`: validates input and coordinates redaction, repository discovery, and persistence.
- `security`: pure, versioned high-confidence redaction. It has no storage access.
- `repository`: discovers Git roots, worktrees, branches, commits, and sanitized remote identity.
- `storage`: the only module allowed to import `bun:sqlite`; owns migrations, transactions, and queries.
- `views`: list formatting, aggregate statistics, and deterministic Markdown export.
- `setup`: Codex, Claude Code, and generic adapters plus safe preview/apply/undo primitives.
- `doctor`: reports executable, database, Git attribution, and adapter health without exposing record bodies.
- `platform`: paths, filesystem permissions, clock/ID injection, hashing, and subprocess boundaries.

The capture data flow is:

```text
stdin or one positional message
  -> enforce byte bound and reject invalid text
  -> redact every user-controlled string
  -> resolve safe repository context
  -> create an immutable record
  -> one short SQLite insert
  -> return safe metadata only
```

No raw observation, remote URL, secret candidate, or unredacted preimage may be written to a temporary file, log, database, error, or report.

## CLI contract

The v1 commands are:

```text
papercuts add TEXT
papercuts add --stdin [--source codex|claude-code|generic|manual]
                       [--model MODEL] [--category CATEGORY]
                       [--tag TAG ...]

papercuts list [--repo current|all] [--since DURATION] [--limit N]
papercuts stats [--repo current|all] [--since DURATION]
papercuts export [--repo current|all] [--since DURATION]
                  [--output FILE] [--force]

papercuts setup codex|claude-code|generic
                 [--scope user|repo] [--undo] [--apply]

papercuts doctor
```

Every command accepts `--help`, `--version`, and `--json`.

### Add behavior

- Exactly one positional message or `--stdin` is required.
- Missing input fails immediately; the command never launches an editor or prompts.
- Harness instructions always use stdin. Positional input exists for human convenience.
- UTF-8 message size is limited to 64 KiB before redaction work begins.
- Empty text, NUL bytes, malformed text, and invalid metadata fail without opening the database.
- `source` defaults to `manual` for human calls. Installed adapters pass their source explicitly.
- Model, category, and tags are optional. They are redacted and length-bounded before persistence.
- Success prints the record ID and safe context, never the submitted message.
- Recording failures remain visible through a nonzero exit code, but installed agent instructions require the primary task to continue.

### Repository-aware reads

- Inside a Git repository, `list`, `stats`, and `export` default to `--repo current`.
- Outside Git, they default to `--repo all`.
- `--repo current` outside Git is a validation error.
- Human and JSON output always state the resolved scope.
- `list` is newest-first with stable `(created_at_ms, id)` ordering and a conservative default limit.
- `stats` reports structural facts only: total, time range, counts by day/source/repository/category, redacted-record count, and exact repeated observations. It does not infer themes.
- `export` writes safe deterministic Markdown to stdout by default. `--output` uses atomic exclusive creation and refuses an existing path unless `--force` is present.

### JSON and exit behavior

With `--json`, stdout contains exactly one versioned JSON object followed by a newline, with no ANSI or prose. Handled errors are JSON on stdout and leave stderr empty.

Success envelope:

```json
{"version":1,"ok":true,"command":"add","data":{},"warnings":[]}
```

Error envelope:

```json
{"version":1,"ok":false,"command":"setup","error":{"code":"setup_conflict","message":"Managed setup content has changed.","retryable":false}}
```

Stable exit codes:

- `0`: success, empty result, or idempotent setup no-op
- `1`: unexpected internal or I/O failure
- `2`: usage or validation error
- `3`: requested record or repository not found
- `4`: setup precondition conflict
- `5`: temporary SQLite lock contention; retryable
- `6`: safety or redaction failure; nothing persisted

## Record model

Records are immutable. V1 does not edit, resolve, reopen, or delete them.

Each record stores:

- UUIDv4 ID
- UTC creation time in epoch milliseconds
- redacted body text
- source: `manual`, `codex`, `claude-code`, or `generic`
- optional redacted model and category
- optional normalized redacted tags
- client version
- nullable repository key and safe display name
- nullable Git branch, full HEAD commit, worktree root, and cwd relative to the worktree
- redaction replacement count and ruleset version

Absolute paths and local fingerprints may exist in the private database for attribution and diagnostics but must not appear in Markdown export. No environment variables, full process arguments, transcript text, diffs, file contents, usernames, hostnames, or raw remote URLs are captured automatically.

## Repository identity

Branches and worktrees are context, not repository identity.

1. Resolve the real Git common directory. Its SHA-256 digest is the local identity and is shared by linked worktrees.
2. Select the primary remote as `origin`, or the only remote when exactly one exists.
3. Parse HTTPS, SSH URL, and SCP-style remotes. Discard userinfo, credentials, query, and fragment before any hashing or diagnostic formatting.
4. Normalize hostname case, default ports, separators, trailing slash, and `.git`; preserve repository path case.
5. When a safe remote exists, its SHA-256 digest is the repository key so separate clones associate. Otherwise use the local identity.

Malformed or ambiguous remotes fall back to local identity. Raw remote strings are never stored or logged.

## SQLite storage

The default external database path on macOS is:

```text
~/Library/Application Support/papercuts/papercuts.sqlite3
```

`PAPERCUTS_HOME` changes the parent directory for tests and alternate profiles. The directory is created with mode `0700`; database and sidecar files are owner-only.

The compiled executable must open the external path at runtime. It must never import or embed the writable database as a build asset.

Every connection uses strict bindings and configures:

- WAL journal mode
- foreign keys enabled
- `synchronous=FULL`
- bounded `busy_timeout`

Writes remain short. Redaction, Git commands, rendering, and filesystem setup do not occur inside a database transaction.

Numbered migrations are shipped with the application, checksummed, and applied under a serialized immediate transaction. A database newer than the binary is refused without mutation. V1 uses conventional SQLite features available from the macOS system SQLite used by Bun.

## Capture-time redaction

Redaction runs before persistence, JSON formatting, diagnostics, hashing of user-controlled metadata, or export.

V1 detects only high-confidence forms:

- recognized credential/token prefixes
- authorization and cookie header values
- private-key blocks
- credential-bearing URLs
- assignments whose key clearly denotes a token, secret, key, or password

Matches are replaced with class-only markers such as `[REDACTED:CREDENTIAL]`. The database stores only the sanitized value, replacement count, and redactor version. It never stores secret-derived hashes or correlation tokens.

The redactor is fail-closed. It has no bypass flag, raw backup, recovery store, verbose payload log, or entropy-based heuristic. Patterns must be simple and performance-tested; byte bounds are applied before regular expressions run.

Capture-time redaction reduces accidental retention but is not a vault or complete data-loss-prevention system. Installed instructions still prohibit secrets and large raw output.

## Harness setup

Setup is preview-only unless `--apply` is present. Preview must perform literally zero writes: no instruction changes, database creation, application directory creation, cache file, lock file, or timestamp update.

User scope is the default because this is a personal tool. Repository scope is available explicitly.

### Codex

- Resolve `CODEX_HOME`, defaulting to `~/.codex`.
- Use the active global guidance file according to Codex precedence.
- Install one versioned, uniquely marked managed block.
- If a non-empty global override would shadow the intended file, target the active file or report a clear conflict; never claim installation into an ignored file.

### Claude Code

- User scope owns `~/.claude/rules/papercuts.md`.
- Repository scope owns `.claude/rules/papercuts.md`.
- The adapter-owned file contains only the generated instructions, which makes apply and undo exact.

### Generic

- Print the portable instruction snippet.
- Reject `--apply` because no safe target can be inferred.

### Safe apply and undo

Adapters produce an ephemeral plan containing target path, preimage digest, desired bytes, safe managed diff, and mode. Plans are never serialized.

Apply and undo:

- reject symlinks, non-regular files, malformed or duplicate markers, and paths outside the selected scope
- preserve unrelated bytes, newline style, and existing mode
- recheck the preimage digest immediately before writing
- write a same-directory exclusive temporary file, flush it, rename atomically, and flush the directory
- create owned instruction files with mode `0600`
- make repeated apply and undo operations successful no-ops
- delete a file only when it is entirely adapter-owned
- never create broad backup copies of user configuration

Installed instructions tell agents to:

- proactively record small concrete friction without asking
- use one or two sentences: what they were doing, what got in the way, and an optional suspected cause or fix
- record each distinct issue at most once per task
- avoid secrets, raw transcripts, and large command output
- distinguish papercuts from accomplishments and tracked bugs
- use stdin and the correct `--source`
- continue the primary task if capture fails
- never log a `papercuts` capture failure as another papercut
- never run transcript review automatically

## Doctor command

`papercuts doctor` reports:

- CLI and Bun/compiled runtime version
- resolved external data directory
- directory/database ownership and permission problems
- schema version, SQLite integrity result, and lock availability
- current Git repository attribution when applicable
- Codex and Claude Code setup state, target paths, and shadowing/conflicts
- whether `papercuts` is discoverable on `PATH`

It never prints stored messages, raw remotes, environment values, or instruction-file contents.

## Verification strategy

Use `bun:test` for unit and integration tests, TypeScript for static checking, and compiled-binary smoke tests. Every behavior change follows red-green-refactor: write a focused failing test, observe the expected failure, implement the minimum, and rerun the focused and relevant full suites.

Release gates:

1. Synthetic secret canaries are absent byte-for-byte from queried rows, database/WAL files, stdout, stderr, diagnostics, and exports.
2. Fifty parallel first-use captures create fifty intact records, one schema, and a passing SQLite integrity check.
3. Repositories, subdirectories, linked worktrees, separate clones, credential-bearing remotes, unborn branches, detached HEADs, and non-Git directories attribute safely.
4. Setup preview leaves fixture trees byte-identical and creates nothing. Apply, reapply, undo preview, and undo apply are idempotent and byte-safe. Symlinks, malformed markers, scope escapes, and concurrent edits fail without mutation.
5. A standalone executable run with Bun and Node absent from `PATH` persists add/list/export data across separate invocations in an external database.
6. Older schema fixtures upgrade safely; concurrent migrators serialize; a future schema is refused without mutation.
7. Hostile Markdown, HTML, Unicode, and long backtick runs remain inert data in deterministic exports.
8. `bun test`, `bun run typecheck`, and `bun run build` all exit successfully with clean output.

## Parallel implementation boundaries

One integrator owns shared files: package manifest and lockfile, TypeScript configuration, domain contracts, CLI registry/entrypoint, README, and end-to-end tests.

After the shared contracts are committed, independent worktrees may implement:

- storage and migrations
- capture, redaction, and repository attribution
- setup adapters and atomic filesystem mutation
- read views, statistics, and Markdown export

Each workstream owns disjoint source and test directories, uses TDD, commits independently, and receives a task-scoped spec and quality review before integration. A final whole-branch review follows the complete acceptance suite.

## Explicitly deferred

- transcript discovery, parsing, mining, import, or backfill
- cloud sync, accounts, teams, or multi-machine reconciliation
- daemon, background watcher, API server, or queue
- semantic clustering, embeddings, LLM summaries, or automated diagnosis
- issue creation, remediation, resolution state, editing, or deletion
- committed per-repository papercut ledgers or per-repository databases
- TUI, editor, pager, or interactive capture prompts
- arbitrary adapter/plugin framework
- automatic merging of ambiguous remotes
- packaging, notarization, or public distribution

## Source references

- Bun can compile TypeScript and `bun:sqlite` into standalone executables: <https://bun.com/docs/bundler/executables>
- Bun SQLite API and strict-binding behavior: <https://bun.com/docs/runtime/sqlite>
- Codex global and repository instruction discovery: <https://learn.chatgpt.com/docs/agent-configuration/agents-md>
- Claude Code user-level and repository instruction locations: <https://code.claude.com/docs/en/memory>
