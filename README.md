# papercuts

`papercuts` is a personal, local-first CLI for recording small workflow
friction while you (or a coding agent) work: a dead-end tool call, a stale
cache, a broken link, a misleading error, a flaky command, an undocumented
setup step, a non-obvious gotcha. Records land in one private SQLite database
on your machine and can be filtered by repository, summarized, or exported to
Markdown.

There is no daemon, no network component, no account system, and no cloud
sync. Everything is local, everything is opt-in.

## Project site

The product site is live at [papercuts.claxx.gg](https://papercuts.claxx.gg).
It is a static overview of the CLI, not a hosted application: it receives no
papercut records and has no access to the local SQLite database. A deliberately
more theatrical alternate presentation is available at
[/museum.html](https://papercuts.claxx.gg/museum.html).

## What counts as a papercut

A papercut is a **concise observation about friction**, not an accomplishment
log and not an issue tracker. Good examples:

- "The build script silently swallowed a missing env var instead of failing
  fast."
- "Docs said `--flag` but the actual CLI accepts `--flag-name`; wasted a
  retry cycle."
- "`npm test` passes locally but the CI cache masks a flaky suite."

Not a papercut:

- "Implemented the login form." (that's an accomplishment)
- "There's a null-pointer bug in `parseConfig`." (that's a tracked bug —
  file it in the project's normal issue workflow)
- Anything containing a secret, a full transcript, or large raw command
  output — see [Privacy and redaction](#privacy-and-redaction) below.

Record each distinct issue at most once per task, and keep it to one or two
sentences: what you were doing, what got in the way, and optionally a
suspected cause or fix.

## Prerequisites

- [Bun](https://bun.sh) `>= 1.3.0`
- macOS (the default data directory is under
  `~/Library/Application Support`; `PAPERCUTS_HOME` can relocate it, see
  below)

## Install

```bash
bun install
```

This installs the two development dependencies (`typescript`,
`@types/bun`). `papercuts` itself has zero runtime dependencies.

## Development commands

| Purpose | Command | Expected on success |
|---|---|---|
| Run the test suite | `bun test` | all tests pass, no warnings |
| Typecheck | `bun run typecheck` | exit 0, no diagnostics |
| Compile a standalone binary | `bun run build` | exit 0, `dist/papercuts` is executable |
| Everything above | `bun run check` | typecheck, tests, and build all succeed |

You can also run the CLI directly from source without compiling, which is
the fastest loop while developing:

```bash
bun src/index.ts add "..."
```

## Publishing the project site

The static site source lives in [`site/`](site/). Its Cloudflare Worker asset
configuration, including the `papercuts.claxx.gg` custom domain, is in
[`wrangler.jsonc`](wrangler.jsonc). The CLI itself remains entirely local;
deploying the site only uploads those static assets.

After authenticating Wrangler to the intended Cloudflare account, preview and
publish the site from the repository root:

```bash
wrangler deploy --dry-run
wrangler deploy
```

Verify the deployed site with the root page, the museum page, and a missing
path (which should return `404`):

```bash
curl -I https://papercuts.claxx.gg/
curl -I https://papercuts.claxx.gg/museum.html
curl -I https://papercuts.claxx.gg/does-not-exist
```

## Standalone build and smoke test

`bun run build` produces a self-contained executable at `dist/papercuts`
that embeds the Bun runtime. It never embeds the database — the database is
always an external file, created on first write. Verify the binary works
with Bun and Node both absent from `PATH`:

```bash
bun run build
env -i HOME="$HOME" PATH="/usr/bin:/bin" PAPERCUTS_HOME="$(mktemp -d)" ./dist/papercuts --version
# 0.1.0
```

If that prints the version cleanly, the binary is self-contained and ready
to use.

## Optional: put it on your PATH

For everyday use, link the compiled binary somewhere on `PATH` instead of
invoking `bun src/index.ts` or a full `dist/papercuts` path every time:

```bash
bun run build
bun link
```

Or just symlink or copy `dist/papercuts` into a directory already on your
`PATH` (e.g. `~/.local/bin`). `papercuts doctor` reports whether the
executable is discoverable on `PATH`.

## Commands

Every command accepts three global flags in addition to its own:

- `--json` — emit exactly one versioned JSON object to stdout and nothing
  else (no ANSI, no prose)
- `--help` (or `-h`) — print usage for the CLI or, after a command word, for
  that command
- `--version` — print the CLI's semantic version

### `add` — record a papercut

```text
papercuts add TEXT | papercuts add --stdin [--source codex|claude-code|generic|manual] [--model MODEL] [--category CATEGORY] [--tag TAG ...]
```

Exactly one of a positional message or `--stdin` is required — never both,
never neither. `--stdin` is what installed agent instructions use so the
observation text never appears in `argv` or shell history; the positional
form is for humans typing at a terminal. `--source` defaults to `manual`;
installed adapters pass `codex`, `claude-code`, or `generic` explicitly.
`--model`, `--category`, and `--tag` (repeatable, up to 16) are optional.
The body is capped at 64 KiB of UTF-8 before redaction runs; empty text and
NUL bytes are rejected before the database is ever opened.

Via a positional argument:

```bash
$ papercuts add "The build script silently swallowed a missing env var instead of failing fast."
Recorded papercut 62a54897-36de-4904-90a0-da28a17b3226.
Created: 2026-07-11T02:29:51.604Z
Source: manual
Repository: papercuts
Redactions: 0
```

Via stdin, with metadata (this is the form agent instructions install):

```bash
$ echo "Docs said --flag but the actual CLI accepts --flag-name; wasted a retry cycle." \
    | papercuts add --stdin --source manual --category docs --tag cli --tag docs
Recorded papercut 615e4870-7184-4112-bf38-0f03f502d20a.
Created: 2026-07-11T02:29:51.672Z
Source: manual
Repository: papercuts
Redactions: 0
```

Success never echoes the submitted text — only the record ID and safe
context. With `--json`:

```bash
$ echo "Second papercut example." | papercuts add --stdin --json
{"version":1,"ok":true,"command":"add","data":{"id":"8c7819d0-b60a-4750-8757-7068ba24770d","createdAt":"2026-07-11T02:29:51.738Z","source":"manual","repository":{"name":"papercuts"},"redactionCount":0},"warnings":[]}
```

### `list` — list recorded papercuts

```text
papercuts list [--repo current|all] [--since DURATION] [--limit N]
```

Newest first, stable `(created_at_ms, id)` ordering. `--repo` defaults to
the current repository when run inside a Git worktree and to `all`
otherwise; passing `--repo current` outside a Git repository is a
validation error (exit 2). `--since` takes a duration like `30m`, `12h`, or
`7d`. `--limit` is `1`–`1000`, default `50`.

```bash
$ papercuts list --repo all
Papercuts — all repositories

1. Created: `2026-07-11T02:29:51.738Z`
   Source: `manual`
   Repository: `papercuts`
   Branch: `feature/papercuts-cli`
   Working directory: `.`
   Body:
Second papercut example.


2. Created: `2026-07-11T02:29:51.672Z`
   Source: `manual`
   Repository: `papercuts`
   Branch: `feature/papercuts-cli`
   Working directory: `.`
   Category: `docs`
   Tags: `cli`, `docs`
   Body:
Docs said --flag but the actual CLI accepts --flag-name; wasted a retry cycle.
```

```bash
$ papercuts list --repo all --since 1h --limit 2 --json
{"version":1,"ok":true,"command":"list","data":{"scope":{"kind":"all"},"records":[{"id":"...","createdAt":"...","body":"...","source":"manual","model":null,"category":"docs","tags":["cli","docs"],"repository":{"name":"papercuts","branch":"feature/papercuts-cli","cwdRelative":"."},"redactionCount":0}, ...]},"warnings":[]}
```

### `stats` — structural statistics

```text
papercuts stats [--repo current|all] [--since DURATION]
```

Reports facts, not opinions: total count, time range, counts by day,
source, repository, and category, how many records contain any redaction,
total replacement count, and exact repeated (post-redaction) bodies. It
never infers themes, priority, or root cause.

```bash
$ papercuts stats --repo all
Papercut statistics — all repositories

Total: 3
First: `2026-07-11T02:29:51.604Z`
Last: `2026-07-11T02:29:51.738Z`
Redacted records: 0
Replacements: 0

By day:
  `2026-07-11`: 3

By source:
  `manual`: 3

By repository:
  `papercuts`: 3

By category:
  `docs`: 1

Exact repeats:
  (none)
```

```bash
$ papercuts stats --repo all --json
{"version":1,"ok":true,"command":"stats","data":{"scope":{"kind":"all"},"total":3,"firstAt":"2026-07-11T02:29:51.604Z","lastAt":"2026-07-11T02:29:51.738Z","byDay":{"2026-07-11":3},"bySource":{"manual":3},"byRepository":{"papercuts":3},"byCategory":{"docs":1},"redactedRecordCount":0,"replacementCount":0,"exactRepeats":[]},"warnings":[]}
```

### `export` — deterministic Markdown export

```text
papercuts export [--repo current|all] [--since DURATION] [--output FILE] [--force]
```

Without `--output`, Markdown goes to stdout and nothing is written to disk.
With `--output`, the file is created with exclusive, atomic creation — an
existing path is refused unless `--force` is present, in which case the
write goes through a same-directory temp file and an atomic rename.
Exported Markdown omits absolute paths and repository fingerprints; only
safe display fields (name, branch, relative cwd, model, category, tags)
appear.

````bash
$ papercuts export --repo all
# Papercuts

Scope: all repositories

## Papercut 1

- Created: `2026-07-11T02:29:51.604Z`
- Source: `manual`
- Repository: `papercuts`
- Branch: `feature/papercuts-cli`
- Working directory: `.`

```
The build script silently swallowed a missing env var instead of failing fast.
```

...
````

```bash
$ papercuts export --repo all --output ./papercuts.md
Exported 3 papercut(s) — all repositories.

$ papercuts export --repo all --output ./papercuts.md
Invalid input.        # refused: the file already exists

$ papercuts export --repo all --output ./papercuts.md --force
Exported 3 papercut(s) — all repositories.
```

`--json` returns Markdown inline (`markdown` is `null` when `--output` is
used, and `outputPath` is `null` on the stdout form):

```bash
$ papercuts export --repo all --json
{"version":1,"ok":true,"command":"export","data":{"scope":{"kind":"all"},"recordCount":3,"outputPath":null,"markdown":"# Papercuts\n\n..."},"warnings":[]}
```

### `setup` — install or remove harness guidance

```text
papercuts setup codex|claude-code|generic [--scope user|repo] [--undo] [--apply]
```

See [Setup is preview-first](#setup-is-preview-first) below for the safety
model. `--scope` defaults to `user`. `--undo` targets removal instead of
install. Without `--apply`, nothing on disk is ever touched, no matter how
many times you run it.

**Preview (default, zero writes):**

```bash
$ papercuts setup claude-code
Setup claude-code (user scope): install
State: absent
Target: /Users/you/.claude/rules/papercuts.md
  install papercuts.md
  + <!-- papercuts:begin v1 -->
  + ## Papercuts
  + ...
  + <!-- papercuts:end -->
Preview only. Re-run with --apply to write changes.
```

**Apply:**

```bash
$ papercuts setup claude-code --apply
...
Applied.
```

Re-running `--apply` after it's already installed is a safe no-op
(`State: current`). Applying again after the upstream instructions change
version reports `State: outdated` and updates the managed block in place
without touching anything else in the file.

**Undo (preview, then apply):**

```bash
$ papercuts setup claude-code --undo
Setup claude-code (user scope): remove
State: current
Target: /Users/you/.claude/rules/papercuts.md
  remove papercuts.md
  - <!-- papercuts:begin v1 -->
  ...
Preview only. Re-run with --apply to write changes.

$ papercuts setup claude-code --undo --apply
...
Applied.
```

Because `~/.claude/rules/papercuts.md` is entirely adapter-owned, undo
deletes the file. Codex targets a shared file (`AGENTS.md`, or an active
`AGENTS.override.md`) and only ever touches its own marked block, leaving
the rest of the file byte-for-byte untouched.

```bash
$ papercuts setup codex
Setup codex (user scope): install
State: absent
Target: /Users/you/.codex/AGENTS.md
  install AGENTS.md
  + <!-- papercuts:begin v1 -->
  ...
Preview only. Re-run with --apply to write changes.
```

**Generic** just prints the portable instruction snippet — it never writes
anything, and `--apply` is rejected outright because no safe target file
can be inferred for an arbitrary harness:

```bash
$ papercuts setup generic
Setup generic (user scope): install
State: absent

<!-- papercuts:begin v1 -->
## Papercuts
...
<!-- papercuts:end -->

$ papercuts setup generic --apply
Managed setup content has changed.   # exit 4, setup_conflict — always rejected
```

Repository scope (`--scope repo`) targets the current repository's
instruction file (e.g. `.claude/rules/papercuts.md` or repo-root
`AGENTS.md`/`AGENTS.override.md`) instead of your home directory.

`--json` works the same way for preview, apply, and undo — it reflects
exactly what the human output shows, including whether any mutation would
happen:

```bash
$ papercuts setup claude-code --json
{"version":1,"ok":true,"command":"setup","data":{"harness":"claude-code","action":"install","scope":"user","state":"absent","mutations":[{"path":"/Users/you/.claude/rules/papercuts.md","managedDiff":["install papercuts.md","+ <!-- papercuts:begin v1 -->", "..."]}],"snippet":null},"warnings":[]}
```

### `doctor` — environment diagnostics

```text
papercuts doctor
```

Reports executable discoverability on `PATH`, CLI and runtime version, the
resolved external data directory and database's existence/ownership/mode,
SQLite version/schema/integrity/write-lock status, current Git
attribution, and Codex/Claude Code user-setup state. It never prints
record bodies, raw remotes, environment values, or instruction-file
contents — only sanitized, fixed-purpose status messages. Exit code is `0`
when every check is at least a warning, `1` if any check is an error.

```bash
$ papercuts doctor
[warn] path: The papercuts executable was not found on PATH; add it or call it by absolute path.
[ok] cli-version: papercuts 0.1.0
[ok] runtime-version: runtime bun 1.3.4
[ok] data-directory: The external data directory exists with owner-only permissions.
[ok] database-file: The database exists with owner-only permissions.
[ok] sqlite-version: SQLite 3.51.0
[ok] schema-version: Schema version 1 matches this build.
[ok] integrity: The database integrity check passed.
[ok] write-lock: A cooperative write lock is available.
[ok] git-attribution: The current directory maps to a tracked repository.
[ok] setup-codex-user: Codex user setup is not installed (optional).
[ok] setup-claude-user: Claude Code user setup is not installed (optional).
Doctor: ok
```

```bash
$ papercuts doctor --json
{"version":1,"ok":true,"command":"doctor","data":{"ok":true,"checks":[{"name":"path","status":"warn","message":"..."}, ...]},"warnings":[]}
```

### `--help` and `--version`

```bash
$ papercuts --help
Usage: papercuts <command> [options]
...

$ papercuts add --help
papercuts add TEXT | papercuts add --stdin [--source codex|claude-code|generic|manual] [--model MODEL] [--category CATEGORY] [--tag TAG ...]

$ papercuts --version
0.1.0
```

`--help` and `--version` never resolve the data path or open SQLite, so
they work even before you've run `papercuts` for the first time.

## JSON mode

Every command accepts `--json`. When present, stdout contains **exactly
one** versioned JSON object followed by a newline — no ANSI escapes, no
extra prose, nothing else on stdout. A handled error is still JSON on
stdout, with stderr left empty; only unexpected/unhandled failures would
ever write to stderr in JSON mode.

Success envelope:

```json
{"version":1,"ok":true,"command":"add","data":{...},"warnings":[]}
```

Error envelope:

```json
{"version":1,"ok":false,"command":"setup","error":{"code":"setup_conflict","message":"Managed setup content has changed.","retryable":false}}
```

`data` shapes are fixed per command (`add`, `list`, `stats`, `export`,
`setup`, `doctor`, `help`, `version`) — see the examples above for each.
Stable exit codes, independent of `--json`:

| Exit | Meaning |
|---|---|
| `0` | success, empty result, or idempotent setup no-op |
| `1` | unexpected internal or I/O failure |
| `2` | usage or validation error |
| `3` | requested record or repository not found |
| `4` | setup precondition conflict |
| `5` | temporary SQLite lock contention — retryable |
| `6` | safety or redaction failure — nothing was persisted |

## Where data lives

The default database is:

```text
~/Library/Application Support/papercuts/papercuts.sqlite3
```

Set `PAPERCUTS_HOME` to redirect the *parent directory* itself (not just a
prefix) — useful for tests, alternate profiles, or keeping the store on a
different volume:

```bash
export PAPERCUTS_HOME="$HOME/somewhere/papercuts-data"
# database is now $PAPERCUTS_HOME/papercuts.sqlite3
```

`PAPERCUTS_HOME` must be an absolute path. The data directory is created
with mode `0700`; the database and its `-wal`/`-shm` sidecars are `0600`.
Nothing is ever written outside this one directory (setup's managed files
live under your home directory or repository, and are documented
separately below).

## Privacy and redaction

Every user-controlled string — the body, model, category, tags, and every
piece of Git-derived context (repository display name, root, relative cwd,
branch, HEAD) — is passed through a pure, versioned redactor **before** it
is persisted, formatted as JSON, logged in diagnostics, or exported. There
is no bypass flag, no raw backup, and no recovery store: if redaction
fails, nothing is written at all (exit `6`).

The redactor recognizes high-confidence forms only:

- recognized credential/token prefixes (e.g. `ghp_…`, `sk-…`, `xox…`) →
  `[REDACTED:CREDENTIAL]`
- `Authorization:` and `Cookie:` header values → `[REDACTED:AUTHORIZATION]`
  / `[REDACTED:COOKIE]`
- PEM-style private-key blocks → `[REDACTED:PRIVATE_KEY]`
- credential-bearing URLs (`https://user:pass@host/...`) →
  `[REDACTED:URL_CREDENTIAL]`
- assignments whose key name clearly denotes a token, secret, key, or
  password (`API_TOKEN=...`, `password: "..."`) → `[REDACTED:SECRET]`

```bash
$ echo "The install script printed ghp_AAAAAAAAAAAAAAAAAAAAAAAA to stdout instead of masking it." \
    | papercuts add --stdin --json
{"version":1,"ok":true,"command":"add","data":{...,"redactionCount":1},"warnings":[]}

$ papercuts list --repo all --json
{"...":"...","data":{"...","records":[{"body":"The install script printed [REDACTED:CREDENTIAL] to stdout instead of masking it.\n", ...}]}}
```

**This is best-effort pattern redaction, not a data-loss-prevention (DLP)
guarantee.** It catches the high-confidence forms listed above and nothing
more — it does not detect arbitrary secrets, does not use entropy
heuristics, and cannot catch a secret that doesn't match one of these
patterns. Treat it as a safety net, not a reason to paste raw credentials
or large command output into a papercut. The installed agent instructions
say the same thing explicitly: avoid secrets and large raw output in the
first place.

Absolute paths and local repository fingerprints (a hash of the Git
common-directory's device/inode, or of a screened normalized remote) may
exist in the private database for attribution, but never appear in
Markdown export, `doctor` output, or any diagnostic.

## Setup is preview-first

`papercuts setup <harness>` never writes anything unless you pass
`--apply` — not a database, not a cache file, not a lock file, not even a
timestamp. You can run preview as many times as you like to see exactly
what would change before committing to it.

When you do `--apply`, the adapter:

- only ever touches its own uniquely marked block
  (`<!-- papercuts:begin v1 -->` … `<!-- papercuts:end -->`), preserving
  every other byte, the existing newline style, and the existing file mode
- rejects symlinked parents/targets, non-regular files, and malformed or
  duplicate markers rather than guessing
- rechecks the file's content hash immediately before writing, so a
  conflicting edit made between preview and apply is caught, not
  silently overwritten
- writes through a same-directory temp file and an atomic rename
- makes repeated apply/undo calls safe no-ops
- only deletes a file when the whole file is adapter-owned (Claude Code's
  `papercuts.md`); a shared file like Codex's `AGENTS.md` only ever loses
  its managed block

If something looks wrong — an unreadable target, markers that don't match
the current version, or a file that changed between preview and apply —
setup reports a conflict (exit `4`) instead of guessing.

## Explicitly deferred

These are intentionally out of scope for v1 — not oversights:

- transcript discovery, parsing, mining, import, or backfill (papercuts
  never reads your agent's conversation transcripts)
- cloud sync, accounts, teams, or multi-machine reconciliation
- daemon, background watcher, API server, or queue
- semantic clustering, embeddings, LLM summaries, or automated diagnosis
- issue creation, remediation, resolution state, editing, or deletion of
  records — records are immutable and v1 has no `edit`/`delete`/`resolve`
- committed per-repository papercut ledgers or per-repository databases
- a TUI, editor, pager, or interactive capture prompt
- an arbitrary adapter/plugin framework for harnesses beyond Codex, Claude
  Code, and generic
- automatic merging of ambiguous remotes (multiple non-`origin` remotes
  fall back to local identity rather than guessing)
- packaging, notarization, or public distribution

## Dogfooding example

This is the kind of thing `papercuts` is for. While building this CLI, one
real papercut worth capturing is a zsh gotcha:

```bash
$ papercuts add "In zsh, assigning to lowercase 'path' rebinds the special tied array that backs \$PATH, so later commands in the same shell session can appear to go missing; use a different variable name (e.g. 'search_path') or scope it with 'local path'." --category shell --tag zsh
Recorded papercut 324ae8fb-ca67-471a-bd91-f32821ab8719.
Created: 2026-07-11T02:31:23.311Z
Source: manual
Repository: papercuts
Redactions: 0
```

In zsh, `path` (lowercase) is a special parameter tied to `$PATH` — every
element of one is mirrored into the other. Assigning `path=(...)`
anywhere — a stray local variable, a copy-pasted snippet, a script sourced
into your interactive shell — silently rewrites your command-search path.
The symptom shows up later and looks unrelated: a command that worked a
minute ago now reports "command not found," with no error at the point
where `path` was actually reassigned. It's exactly the kind of
non-obvious, easy-to-forget gotcha `papercuts` exists to accumulate so it
stops costing you (or your agent) a fresh debugging cycle every time.
