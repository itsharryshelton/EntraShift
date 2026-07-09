/**
 * Per-user migration reports (`/api/reports`, SoW Phase 4/5).
 * items succeeded/skipped/failed, data volume, duration, delta-pass summary; CSV export.
 *
 * `itemsSucceeded` is derived: progressCurrent (items the engine reports as processed) minus the
 * skipped/failed logged in job_items, floored at zero. Read-only — no budget writes.
 */

import { Hono } from 'hono';
import type { PerUserReport } from '@shared/contracts';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';
import { secondsBetween } from '../lib/time';
import { serializeCsv } from '../lib/csv';
import * as jobsDb from '../db/jobs';
import * as jobItemsDb from '../db/jobItems';
import * as usersDb from '../db/migrationUsers';

export const reportsRouter = new Hono<AppEnv>();

async function buildReport(db: D1Database, migrationUserId: string): Promise<PerUserReport | null> {
  const user = await usersDb.getById(db, migrationUserId);
  if (!user) return null;

  const jobs = await jobsDb.listByMigrationUser(db, migrationUserId);
  const workloads: PerUserReport['workloads'] = [];
  for (const job of jobs) {
    const { skipped, failed } = await jobItemsDb.countsByJob(db, job.id);
    const internal = await jobsDb.getInternal(db, job.id);
    workloads.push({
      workload: job.workload,
      status: job.status,
      itemsSucceeded: Math.max(job.progressCurrent - skipped - failed, 0),
      itemsSkipped: skipped,
      itemsFailed: failed,
      bytes: job.bytesDone,
      durationSec: job.startedAt && job.completedAt ? secondsBetween(job.startedAt, job.completedAt) : null,
      deltaPasses: internal?.deltaPasses ?? 0,
    });
  }

  return { migrationUserId, sourceEmail: user.sourceEmail, targetUpn: user.targetUpn ?? '', workloads };
}

/** GET /api/reports/:migrationUserId */
reportsRouter.get('/:migrationUserId', async (c) => {
  const report = await buildReport(c.env.DB, c.req.param('migrationUserId'));
  if (!report) throw err.notFound('Migration user not found');
  return c.json(report);
});

/** GET /api/reports/:migrationUserId/export — CSV. */
reportsRouter.get('/:migrationUserId/export', async (c) => {
  const report = await buildReport(c.env.DB, c.req.param('migrationUserId'));
  if (!report) throw err.notFound('Migration user not found');

  const rows = report.workloads.map((w) => [
    report.sourceEmail,
    report.targetUpn,
    w.workload,
    w.status,
    w.itemsSucceeded,
    w.itemsSkipped,
    w.itemsFailed,
    w.bytes,
    w.durationSec,
    w.deltaPasses,
  ]);
  const csv = serializeCsv(
    ['SourceEmail', 'TargetUpn', 'Workload', 'Status', 'ItemsSucceeded', 'ItemsSkipped', 'ItemsFailed', 'Bytes', 'DurationSec', 'DeltaPasses'],
    rows,
  );
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="entrashift-report-${report.migrationUserId}.csv"`,
    },
  });
});
