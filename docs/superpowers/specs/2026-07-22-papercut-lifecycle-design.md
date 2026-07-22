# Papercut Lifecycle Design

## Goal

Allow an addressed papercut to leave the default active review set without
destroying the original observation.

## Commands

- `papercuts resolve <id>` marks one existing papercut resolved.
- `papercuts reopen <id>` returns one resolved papercut to the active set.
- `papercuts list`, `stats`, and `export` show active papercuts by default.
- `papercuts list --include-resolved`, `stats --include-resolved`, and
  `export --include-resolved` include both active and resolved papercuts.

`resolve` and `reopen` are idempotent. Malformed ids return `invalid_input`;
an id absent from the store returns the existing sanitized `not_found` error.

## Data model

Schema version 2 adds a nullable `resolved_at_ms` column to `papercuts` and an
index supporting active-record queries. The immutable capture fields remain
unchanged. A non-null timestamp means resolved; null means active.

The migration only adds metadata. It does not remove or rewrite existing
papercuts, so old records remain active after upgrade.

## Output

Lifecycle commands report the id and whether it is resolved. JSON commands use
the existing versioned success envelope. Read commands only change their
record-selection behavior; their record payload shape remains stable.

## Non-goals

- Permanent deletion or record editing.
- Resolution reasons, users, or external issue links.
- Changing harness capture guidance.
