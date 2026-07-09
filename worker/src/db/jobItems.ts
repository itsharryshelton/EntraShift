/** D1 access for `job_items` — the item-level skip-and-log (never fails the whole job). */

import type { ItemStatus, JobItem } from '@shared/contracts';
import { nowIso } from '../lib/time';
import { uuid } from '../lib/ids';

interface JobItemRowRaw {
  id: string;
  job_id: string;
  item_id: string;
  folder_path: string | null;
  status: string;
  error_class: string;
  error_detail: string;
  created_at: string;
}

function map(r: JobItemRowRaw): JobItem {
  return {
    id: r.id,
    jobId: r.job_id,
    itemId: r.item_id,
    folderPath: r.folder_path,
    status: r.status as ItemStatus,
    errorClass: r.error_class,
    errorDetail: r.error_detail,
    createdAt: r.created_at,
  };
}

export interface ItemLogInput {
  itemId: string;
  folderPath?: string;
  status: ItemStatus;
  errorClass: string;
  errorDetail: string;
}

/**
 * Insert a batch of item logs in a single D1 batch() (one logical write op, free-tier friendly).
 * Returns the count inserted.
 */
export async function insertBatch(db: D1Database, jobId: string, items: ItemLogInput[]): Promise<number> {
  if (items.length === 0) return 0;
  const now = nowIso();
  const stmt = db.prepare(
    `INSERT INTO job_items (id, job_id, item_id, folder_path, status, error_class, error_detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const batch = items.map((it) =>
    stmt.bind(uuid(), jobId, it.itemId, it.folderPath ?? null, it.status, it.errorClass, it.errorDetail, now),
  );
  await db.batch(batch);
  return items.length;
}

export async function listByJob(db: D1Database, jobId: string): Promise<JobItem[]> {
  const { results } = await db
    .prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY created_at')
    .bind(jobId)
    .all<JobItemRowRaw>();
  return results.map(map);
}

/** Skipped/failed counts for a job (used in per-user reports). */
export async function countsByJob(db: D1Database, jobId: string): Promise<{ skipped: number; failed: number }> {
  const { results } = await db
    .prepare('SELECT status, COUNT(*) AS n FROM job_items WHERE job_id = ? GROUP BY status')
    .bind(jobId)
    .all<{ status: string; n: number }>();
  let skipped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'skipped') skipped = r.n;
    else if (r.status === 'failed') failed = r.n;
  }
  return { skipped, failed };
}
