# Papercut Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reversible resolve and reopen commands that remove addressed papercuts from the default active views.

**Architecture:** Store lifecycle state as a nullable resolution timestamp on the existing `papercuts` table. Extend the store query and mutation interfaces, then route two narrow CLI commands through them. Existing read commands opt into the active-only filter unless `--include-resolved` is supplied.

**Tech Stack:** TypeScript, Bun SQLite, Bun test runner.

## Global Constraints

- Preserve captured papercut content and metadata; do not implement deletion.
- Existing database records must upgrade as active.
- Keep human errors sanitized and JSON envelopes versioned.
- Do not touch the unrelated untracked file in the primary worktree.

---

### Task 1: Add store lifecycle state and migration

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/sqlite-store.ts`
- Test: `test/storage/sqlite-store.test.ts`

**Interfaces:**
- Produces `PapercutQuery.includeResolved?: boolean` and `PapercutStore.setResolved(id, resolvedAtMs)`.
- Produces schema v2 with nullable `resolved_at_ms`.

- [x] **Step 1: Write failing store tests**

```ts
store.setResolved(record.id, 1_700_000_000_000);
expect(store.list({ order: "newest" })).toEqual([]);
expect(store.list({ order: "newest", includeResolved: true })).toHaveLength(1);
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `bun test test/storage/sqlite-store.test.ts`
Expected: TypeScript or assertion failure because `setResolved` and `includeResolved` do not exist.

- [x] **Step 3: Implement the minimal migration and store behavior**

```sql
ALTER TABLE papercuts ADD COLUMN resolved_at_ms INTEGER;
CREATE INDEX papercuts_active_created_idx
  ON papercuts(created_at_ms DESC, id DESC)
  WHERE resolved_at_ms IS NULL;
```

Add `setResolved` using one parameterized update and make `list` add
`resolved_at_ms IS NULL` unless `includeResolved` is true.

- [x] **Step 4: Run the focused test to verify it passes**

Run: `bun test test/storage/sqlite-store.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/domain/types.ts src/storage/migrations.ts src/storage/sqlite-store.ts test/storage/sqlite-store.test.ts
git commit -m "feat: add papercut resolution lifecycle"
```

### Task 2: Add command parsing, routing, and output

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `src/cli/run.ts`
- Modify: `test/cli/args.test.ts`
- Modify: `test/cli/run.test.ts`

**Interfaces:**
- Consumes `PapercutStore.setResolved(id, resolvedAtMs)` and `PapercutQuery.includeResolved`.
- Produces `resolve`, `reopen`, and `--include-resolved` CLI behavior.

- [x] **Step 1: Write failing parser and runner tests**

```ts
expect(parse(["resolve", id])).toEqual({ kind: "resolve", id, json: false });
expect(parse(["list", "--include-resolved"])).toMatchObject({ includeResolved: true });
```

Add runner tests asserting resolve hides a record by default, reopen restores it,
and JSON output reports the resolved state.

- [x] **Step 2: Run focused tests to verify they fail**

Run: `bun test test/cli/args.test.ts test/cli/run.test.ts`
Expected: FAIL because the commands and flag are unknown.

- [x] **Step 3: Implement the minimal command surface**

```ts
type LifecycleCommand = { kind: "resolve" | "reopen"; id: string; json: boolean };
```

Validate a UUID-shaped id, call `setResolved(id, runtime.now())` for resolve
and `setResolved(id, null)` for reopen, then emit `{ id, resolved }`.

- [x] **Step 4: Run focused tests to verify they pass**

Run: `bun test test/cli/args.test.ts test/cli/run.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/run.ts test/cli/args.test.ts test/cli/run.test.ts
git commit -m "feat: expose papercut resolve and reopen commands"
```

### Task 3: Document and verify the public contract

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-22-papercut-lifecycle-design.md`
- Modify: `docs/superpowers/plans/2026-07-22-papercut-lifecycle.md`

**Interfaces:**
- Documents command syntax, active-only defaults, and opt-in resolved views.

- [x] **Step 1: Add README examples**

```text
papercuts resolve 62a54897-36de-4904-90a0-da28a17b3226
papercuts list --include-resolved
papercuts reopen 62a54897-36de-4904-90a0-da28a17b3226
```

- [x] **Step 2: Run full verification**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all commands exit 0.

- [x] **Step 3: Commit**

```bash
git add README.md docs/superpowers/specs/2026-07-22-papercut-lifecycle-design.md docs/superpowers/plans/2026-07-22-papercut-lifecycle.md
git commit -m "docs: document papercut lifecycle commands"
```
