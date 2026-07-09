/**
 * Jobs / migration control (`/api/jobs`, SoW Phase 4).
 *
 * Creating jobs is the ONLY thing that touches Queues: one tiny `JobDispatchMessage` per
 * user+workload. All subsequent state/progress flows through D1 (never back through Queues),
 * to stay inside the 10k-ops/day free-tier budget.
 */

import { Hono } from 'hono';
import type { Job, JobDispatchMessage, Workload } from '@shared/contracts';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';
import { uuid } from '../lib/ids';
import { nowIso } from '../lib/time';
import { billUsage } from '../lib/budget';
import { audit } from '../lib/audit';
import * as jobsDb from '../db/jobs';
import * as usersDb from '../db/migrationUsers';

export const jobsRouter = new Hono<AppEnv>();

// A retry is only valid from a terminal failure state.
const RETRYABLE = new Set(['auth_expired', 'permission_revoked', 'quota_exceeded', 'failed']);

/** Enqueue one dispatch message and bill a queue op. */
async function enqueueDispatch(
  c: Context<AppEnv>,
  msg: JobDispatchMessage,
): Promise<void> {
  await c.env.JOB_QUEUE.send(msg);
  billUsage(c.executionCtx, c.env, { queueOps: 1 });
}

/** POST /api/jobs — create one job per user+selected-workload; enqueue a dispatch each. */
jobsRouter.post('/', async (c) => {
  const body = await c.req.json<{ migrationUserIds?: string[] }>();
  const ids = body.migrationUserIds ?? [];
  if (!Array.isArray(ids) || ids.length === 0) throw err.validation('migrationUserIds[] is required');

  const actor = c.get('session').actorUpn;
  const created: Job[] = [];
  const skipped: Array<{ migrationUserId: string; reason: string }> = [];

  for (const id of ids) {
    const user = await usersDb.getById(c.env.DB, id);
    if (!user) {
      skipped.push({ migrationUserId: id, reason: 'not found' });
      continue;
    }
    const targetUpn = user.targetUpn ?? user.targetEmail;
    if (!targetUpn) {
      skipped.push({ migrationUserId: id, reason: 'no resolved target UPN — map first' });
      continue;
    }
    if (user.mappingStatus === 'invalid') {
      skipped.push({ migrationUserId: id, reason: 'mapping is invalid' });
      continue;
    }

    const workloads: Workload[] = [];
    if (user.migrateExchange) workloads.push('exchange');
    if (user.migrateOneDrive) workloads.push('onedrive');
    if (workloads.length === 0) {
      skipped.push({ migrationUserId: id, reason: 'no workload selected' });
      continue;
    }

    for (const workload of workloads) {
      const { id: jobId, dispatchSeq } = await jobsDb.create(c.env.DB, {
        id: uuid(),
        migrationUserId: id,
        workload,
        dispatchSeq: 1,
        createdAt: nowIso(),
      });
      billUsage(c.executionCtx, c.env, { d1Writes: 1 });

      await enqueueDispatch(c, {
        jobId,
        migrationUserId: id,
        workload,
        sourceEmail: user.sourceEmail,
        targetUpn,
        includeArchive: user.includeArchive,
        pass: 'full',
        dispatchSeq,
      });
      const createdJob = await jobsDb.getById(c.env.DB, jobId);
      if (createdJob) created.push(createdJob);
    }

    await audit(c.env.DB, actor, 'job_start', user.sourceEmail, `workloads: ${workloads.join(', ')}`);
    billUsage(c.executionCtx, c.env, { d1Writes: 1 });
  }

  // Client contract: POST /api/jobs → Job[] (the created jobs). Users skipped due to
  // missing target / no workload are logged (the UI pre-filters, so this is rare).
  if (skipped.length) console.warn('POST /api/jobs skipped some users:', skipped);
  return c.json(created, 201);
});

/** GET /api/jobs — Migration Monitor list. */
jobsRouter.get('/', async (c) => {
  return c.json(await jobsDb.listAll(c.env.DB));
});

/** GET /api/jobs/:id — job detail. */
jobsRouter.get('/:id', async (c) => {
  const job = await jobsDb.getById(c.env.DB, c.req.param('id'));
  if (!job) throw err.notFound('Job not found');
  return c.json(job);
});

/** POST /api/jobs/:id/cancel — cancel (engine sees the status on its next poll and stops). */
jobsRouter.post('/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const job = await jobsDb.getById(c.env.DB, id);
  if (!job) throw err.notFound('Job not found');

  await jobsDb.updateStatus(c.env.DB, id, 'cancelled', null, null);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  await audit(c.env.DB, c.get('session').actorUpn, 'job_cancel', job.sourceEmail, `${job.workload}`);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  return c.json({ ok: true });
});

/** POST /api/jobs/:id/retry — re-dispatch a failed job. */
jobsRouter.post('/:id/retry', async (c) => {
  const id = c.req.param('id');
  const job = await jobsDb.getById(c.env.DB, id);
  if (!job) throw err.notFound('Job not found');
  if (!RETRYABLE.has(job.status)) throw err.conflict(`Job in status '${job.status}' is not retryable`);

  const user = await usersDb.getById(c.env.DB, job.migrationUserId);
  const dispatchSeq = await jobsDb.prepareRetry(c.env.DB, id);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  await enqueueDispatch(c, {
    jobId: id,
    migrationUserId: job.migrationUserId,
    workload: job.workload,
    sourceEmail: job.sourceEmail,
    targetUpn: job.targetUpn,
    includeArchive: user?.includeArchive ?? false,
    pass: 'full',
    dispatchSeq,
  });

  await audit(c.env.DB, c.get('session').actorUpn, 'job_retry', job.sourceEmail, `${job.workload}`);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  return c.json({ ok: true });
});

/** POST /api/jobs/:id/delta — queue an incremental (delta) pass. */
jobsRouter.post('/:id/delta', async (c) => {
  const id = c.req.param('id');
  const job = await jobsDb.getById(c.env.DB, id);
  if (!job) throw err.notFound('Job not found');

  const user = await usersDb.getById(c.env.DB, job.migrationUserId);
  const dispatchSeq = await jobsDb.prepareDelta(c.env.DB, id);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  await enqueueDispatch(c, {
    jobId: id,
    migrationUserId: job.migrationUserId,
    workload: job.workload,
    sourceEmail: job.sourceEmail,
    targetUpn: job.targetUpn,
    includeArchive: user?.includeArchive ?? false,
    pass: 'delta',
    dispatchSeq,
  });

  // No dedicated 'delta' audit action; record as a job_start with a delta note.
  await audit(c.env.DB, c.get('session').actorUpn, 'job_start', job.sourceEmail, `${job.workload} delta pass`);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  return c.json({ ok: true });
});
