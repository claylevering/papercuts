import type { Papercut } from "../domain/types";

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

export function summarize(records: readonly Papercut[]): StatsSummary {
  const byDay = new Map<string, number>();
  const bySource = new Map<string, number>();
  const byRepository = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const byBody = new Map<string, number>();
  let firstAtMs: number | null = null;
  let lastAtMs: number | null = null;
  let redactedRecordCount = 0;
  let replacementCount = 0;

  for (const record of records) {
    const createdAt = new Date(record.createdAtMs).toISOString();
    increment(byDay, createdAt.slice(0, 10));
    increment(bySource, record.source);
    if (record.repo !== null) {
      increment(byRepository, record.repo.displayName);
    }
    if (record.category !== null) {
      increment(byCategory, record.category);
    }
    increment(byBody, record.body);

    firstAtMs =
      firstAtMs === null
        ? record.createdAtMs
        : Math.min(firstAtMs, record.createdAtMs);
    lastAtMs =
      lastAtMs === null
        ? record.createdAtMs
        : Math.max(lastAtMs, record.createdAtMs);
    if (record.redactionCount > 0) redactedRecordCount += 1;
    replacementCount += record.redactionCount;
  }

  return {
    total: records.length,
    firstAt: firstAtMs === null ? null : new Date(firstAtMs).toISOString(),
    lastAt: lastAtMs === null ? null : new Date(lastAtMs).toISOString(),
    byDay: toLexicalRecord(byDay),
    bySource: toLexicalRecord(bySource),
    byRepository: toLexicalRecord(byRepository),
    byCategory: toLexicalRecord(byCategory),
    redactedRecordCount,
    replacementCount,
    exactRepeats: [...byBody]
      .filter(([, count]) => count > 1)
      .sort(([left], [right]) => compareLexically(left, right))
      .map(([body, count]) => ({ body, count })),
  };
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function toLexicalRecord(
  counts: ReadonlyMap<string, number>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => compareLexically(left, right)),
  );
}

function compareLexically(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
