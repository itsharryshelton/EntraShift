/**
 * D1 access for `jobs` — one row per (migration_user, workload). D1 is the source of truth
 * for job state; the VM reports progress/checkpoints here (never back through Queues).
 *
 * The public `Job` shape (contracts.ts) joins in `source_email` + `target_upn` from
 * migration_users so the engine and UI have everything they need in one record.
 */

import type { Job, JobStatus, Workload } from '@shared/contracts';
import { nowIso } from '../lib/time';

interface JobRowRaw {
  id: string;
  migration_user_id: string;
  workload: string;
  status: string;
  phase_text: string | null;
  progress_current: number;
  progress_total: number | null;
  bytes_done: number;
  bytes_total: number | null;
  delta_token: string | null;
  checkpoint: string | null;
  attempts: number;
  dispatch_seq: number;
  delta_passes: number;
  last_progress_at: string | null;
  error_class: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  // joined
  source_email: string;
  target_upn: string | null;
}

const SELECT_JOIN = `SELECT j.*, m.source_email AS source_email, m.target_upn AS target_upn
                     FROM jobs j JOIN migration_users m ON m.id = j.migration_user_id`;

function map(r: JobRowRaw): Job {
  return {
    id: r.id,
    migrationUserId: r.migration_user_id,
    sourceEmail: r.source_email,
    targetUpn: r.target_upn ?? '',
    workload: r.workload as Workload,
    status: r.status as JobStatus,
    phaseText: r.phase_text,
    progressCurrent: r.progress_current,
    progressTotal: r.progress_total,
    bytesDone: r.bytes_done,
    bytesTotal: r.bytes_total,
    deltaToken: r.delta_token,
    checkpoint: r.checkpoint ? (JSON.parse(r.checkpoint) as Record<string, unknown>) : null,
    attempts: r.attempts,
    errorClass: r.error_class,
    errorDetail: r.error_detail,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

/** Internal fields not exposed on the wire but needed for floor/dispatch bookkeeping. */
export interface JobInternal {
  id: string;
  status: JobStatus;
  dispatchSeq: number;
  deltaPasses: number;
  lastProgressAt: string | null;
  deltaToken: string | null;
}

export async function getById(db: D1Database, id: string): Promise<Job | null> {
  const raw = await db.prepare(`${SELECT_JOIN} WHERE j.id = ?`).bind(id).first<JobRowRaw>();
  return raw ? map(raw) : null;
}

export async function getInternal(db: D1Database, id: string): Promise<JobInternal | null> {
  const raw = await db
    .prepare('SELECT id, status, dispatch_seq, delta_passes, last_progress_at, delta_token FROM jobs WHERE id = ?')
    .bind(id)
    .first<Pick<JobRowRaw, 'id' | 'status' | 'dispatch_seq' | 'delta_passes' | 'last_progress_at' | 'delta_token'>>();
  if (!raw) return null;
  return {
    id: raw.id,
    status: raw.status as JobStatus,
    dispatchSeq: raw.dispatch_seq,
    deltaPasses: raw.delta_passes,
    lastProgressAt: raw.last_progress_at,
    deltaToken: raw.delta_token,
  };
}

export async function listAll(db: D1Database): Promise<Job[]> {
  const { results } = await db.prepare(`${SELECT_JOIN} ORDER BY j.created_at DESC`).all<JobRowRaw>();
  return results.map(map);
}

export async function listByMigrationUser(db: D1Database, migrationUserId: string): Promise<Job[]> {
  const { results } = await db
    .prepare(`${SELECT_JOIN} WHERE j.migration_user_id = ? ORDER BY j.workload`)
    .bind(migrationUserId)
    .all<JobRowRaw>();
  return results.map(map);
}

export interface CreateJobInput {
  id: string;
  migrationUserId: string;
  workload: Workload;
  dispatchSeq: number;
  createdAt: string;
}

/**
 * Create (or reset if a job for this user+workload already exists) a queued job.
 * Returns the effective row id + dispatch_seq (on conflict the EXISTING id is returned, and
 * dispatch_seq is bumped) so the caller can enqueue a matching, non-stale dispatch message.
 */
export async function create(db: D1Database, j: CreateJobInput): Promise<{ id: string; dispatchSeq: number }> {
  const row = await db
    .prepare(
      `INSERT INTO jobs (id, migration_user_id, workload, status, dispatch_seq, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)
       ON CONFLICT(migration_user_id, workload) DO UPDATE SET
         status = 'queued',
         dispatch_seq = jobs.dispatch_seq + 1,
         -- A re-issued FULL job starts clean: wipe stale run-state so progress/reports/duration
         -- reflect the new pass (retry/delta use their own paths and preserve delta_token).
         progress_current = 0,
         progress_total = NULL,
         bytes_done = 0,
         bytes_total = NULL,
         delta_token = NULL,
         checkpoint = NULL,
         attempts = 0,
         delta_passes = 0,
         last_progress_at = NULL,
         started_at = NULL,
         completed_at = NULL,
         error_class = NULL,
         error_detail = NULL,
         updated_at = excluded.updated_at
       RETURNING id, dispatch_seq`,
    )
    .bind(j.id, j.migrationUserId, j.workload, j.dispatchSeq, j.createdAt, j.createdAt)
    .first<{ id: string; dispatch_seq: number }>();
  return { id: row!.id, dispatchSeq: row!.dispatch_seq };
}

/** Explicit status transition (VM StatusUpdate + UI cancel). Maintains started/completed stamps. */
export async function updateStatus(
  db: D1Database,
  id: string,
  status: JobStatus,
  errorClass: string | null,
  errorDetail: string | null,
): Promise<void> {
  const now = nowIso();
  const terminal = ['completed', 'cancelled', 'auth_expired', 'permission_revoked', 'quota_exceeded', 'failed'];
  await db
    .prepare(
      `UPDATE jobs SET
         status = ?1,
         error_class = ?2,
         error_detail = ?3,
         started_at = COALESCE(started_at, CASE WHEN ?1 IN ('provisioning','running') THEN ?4 ELSE started_at END),
         completed_at = CASE WHEN ?1 IN (${terminal.map((t) => `'${t}'`).join(',')}) THEN ?4 ELSE completed_at END,
         updated_at = ?4
       WHERE id = ?5`,
    )
    .bind(status, errorClass, errorDetail, now, id)
    .run();
}

/** Batched progress write (≤1/job/30s enforced upstream). Stamps last_progress_at. */
export async function updateProgress(
  db: D1Database,
  id: string,
  p: {
    status: JobStatus;
    phaseText?: string;
    progressCurrent?: number;
    progressTotal?: number | null;
    bytesDone?: number;
    bytesTotal?: number | null;
    deltaToken?: string | null;
  },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE jobs SET
         status = ?1,
         phase_text = COALESCE(?2, phase_text),
         progress_current = COALESCE(?3, progress_current),
         progress_total = CASE WHEN ?4 = 1 THEN ?5 ELSE progress_total END,
         bytes_done = COALESCE(?6, bytes_done),
         bytes_total = CASE WHEN ?7 = 1 THEN ?8 ELSE bytes_total END,
         delta_token = CASE WHEN ?9 = 1 THEN ?10 ELSE delta_token END,
         started_at = COALESCE(started_at, ?11),
         last_progress_at = ?11,
         updated_at = ?11
       WHERE id = ?12`,
    )
    .bind(
      p.status,
      p.phaseText ?? null,
      p.progressCurrent ?? null,
      p.progressTotal !== undefined ? 1 : 0,
      p.progressTotal ?? null,
      p.bytesDone ?? null,
      p.bytesTotal !== undefined ? 1 : 0,
      p.bytesTotal ?? null,
      p.deltaToken !== undefined ? 1 : 0,
      p.deltaToken ?? null,
      now,
      id,
    )
    .run();
}

/** Durable resume point (survives VM reboot). */
export async function updateCheckpoint(
  db: D1Database,
  id: string,
  checkpoint: Record<string, unknown>,
  progressCurrent: number,
  bytesDone: number,
): Promise<void> {
  await db
    .prepare('UPDATE jobs SET checkpoint = ?, progress_current = ?, bytes_done = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(checkpoint), progressCurrent, bytesDone, nowIso(), id)
    .run();
}

/** Re-dispatch a failed job: bump dispatch_seq + attempts, reset to queued. Returns new dispatch_seq. */
export async function prepareRetry(db: D1Database, id: string): Promise<number> {
  const now = nowIso();
  const row = await db
    .prepare(
      `UPDATE jobs SET status = 'queued', attempts = attempts + 1, dispatch_seq = dispatch_seq + 1,
         error_class = NULL, error_detail = NULL, updated_at = ?
       WHERE id = ? RETURNING dispatch_seq`,
    )
    .bind(now, id)
    .first<{ dispatch_seq: number }>();
  return row?.dispatch_seq ?? 0;
}

/** Queue a delta pass: mark delta_pending, bump dispatch_seq + delta_passes. Returns new dispatch_seq. */
export async function prepareDelta(db: D1Database, id: string): Promise<number> {
  const now = nowIso();
  const row = await db
    .prepare(
      `UPDATE jobs SET status = 'delta_pending', dispatch_seq = dispatch_seq + 1, delta_passes = delta_passes + 1,
         updated_at = ?
       WHERE id = ? RETURNING dispatch_seq`,
    )
    .bind(now, id)
    .first<{ dispatch_seq: number }>();
  return row?.dispatch_seq ?? 0;
}
