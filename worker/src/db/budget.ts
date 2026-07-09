/** D1 access for `budget_counters` (one row per UTC day). Low-level; governor is in lib/budget.ts. */

import { nowIso, todayUtc } from '../lib/time';

export interface BudgetRow {
  day: string;
  workersRequests: number;
  d1Writes: number;
  queueOps: number;
  degraded: boolean;
}

interface BudgetRowRaw {
  day: string;
  workers_requests: number;
  d1_writes: number;
  queue_ops: number;
  degraded: number;
}

function map(r: BudgetRowRaw): BudgetRow {
  return {
    day: r.day,
    workersRequests: r.workers_requests,
    d1Writes: r.d1_writes,
    queueOps: r.queue_ops,
    degraded: r.degraded === 1,
  };
}

/** Fetch today's counter row (or a zeroed logical row if none yet). */
export async function getToday(db: D1Database): Promise<BudgetRow> {
  const day = todayUtc();
  const raw = await db.prepare('SELECT * FROM budget_counters WHERE day = ?').bind(day).first<BudgetRowRaw>();
  return raw ? map(raw) : { day, workersRequests: 0, d1Writes: 0, queueOps: 0, degraded: false };
}

/**
 * Atomically add deltas to today's counters (creating the row if needed) and return the new totals.
 * NOTE: this write itself is one D1 write; we deliberately do NOT recursively count it, otherwise
 * every counted write would cost two. It is accepted overhead of the governor.
 */
export async function increment(
  db: D1Database,
  deltas: { workers?: number; d1Writes?: number; queueOps?: number },
): Promise<BudgetRow> {
  const day = todayUtc();
  const w = deltas.workers ?? 0;
  const d = deltas.d1Writes ?? 0;
  const q = deltas.queueOps ?? 0;
  const raw = await db
    .prepare(
      `INSERT INTO budget_counters (day, workers_requests, d1_writes, queue_ops, degraded, updated_at)
       VALUES (?1, ?2, ?3, ?4, 0, ?5)
       ON CONFLICT(day) DO UPDATE SET
         workers_requests = workers_requests + ?2,
         d1_writes        = d1_writes + ?3,
         queue_ops        = queue_ops + ?4,
         updated_at       = ?5
       RETURNING *`,
    )
    .bind(day, w, d, q, nowIso())
    .first<BudgetRowRaw>();
  return map(raw!);
}

/** Flip the `degraded` flag for today. */
export async function setDegraded(db: D1Database, degraded: boolean): Promise<void> {
  await db
    .prepare('UPDATE budget_counters SET degraded = ?, updated_at = ? WHERE day = ?')
    .bind(degraded ? 1 : 0, nowIso(), todayUtc())
    .run();
}
