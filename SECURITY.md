# Security Policy

papercuts is a local-first tool: it has no daemon, no network component, and
no account system. Its security-relevant surface is capture-time redaction,
file permissions on the SQLite store, and the preview-first harness setup
mutations.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
(Security tab → "Report a vulnerability"), or email clay@claxx.gg.

Especially interesting reports: any input that survives redaction and reaches
the database, WAL, export, or diagnostics in raw form (see
`test/acceptance/secret-boundary.test.ts` for the canary methodology), and any
setup `--apply` path that mutates bytes outside its managed marker block.

Please do not open public issues for suspected leaks.
