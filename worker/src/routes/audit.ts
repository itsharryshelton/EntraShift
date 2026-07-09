/**
 * Audit log viewer + export (`/api/audit`, SoW Phase 5).
 * Read-only, filterable, keyset-paginated. Export produces the CSV used before 90-day pruning.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { serializeCsv } from '../lib/csv';
import { billUsage } from '../lib/budget';
import { audit } from '../lib/audit';
import * as auditDb from '../db/audit';

export const auditRouter = new Hono<AppEnv>();

/** GET /api/audit?actor=&action=&from=&to=&cursor= */
auditRouter.get('/', async (c) => {
  const { entries, nextCursor } = await auditDb.query(c.env.DB, {
    actor: c.req.query('actor') || undefined,
    action: c.req.query('action') || undefined,
    from: c.req.query('from') || undefined,
    to: c.req.query('to') || undefined,
    cursor: c.req.query('cursor') || undefined,
  });
  // Client contract: Paged<T> = { items, cursor }.
  return c.json({ items: entries, cursor: nextCursor });
});

/** GET /api/audit/export — CSV of all matching entries (page through internally). */
auditRouter.get('/export', async (c) => {
  const filters = {
    actor: c.req.query('actor') || undefined,
    action: c.req.query('action') || undefined,
    from: c.req.query('from') || undefined,
    to: c.req.query('to') || undefined,
  };

  const all: Array<Array<string | null>> = [];
  let cursor: string | null = null;
  // Bounded loop — the 90-day window keeps this small; hard cap for safety.
  for (let page = 0; page < 200; page++) {
    const res = await auditDb.query(c.env.DB, { ...filters, cursor: cursor ?? undefined, limit: 500 });
    for (const e of res.entries) all.push([e.createdAt, e.actorUpn, e.action, e.target, e.detail]);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }

  const csv = serializeCsv(['CreatedAt', 'ActorUpn', 'Action', 'Target', 'Detail'], all);

  await audit(c.env.DB, c.get('session').actorUpn, 'audit_export', null, `exported ${all.length} entries`);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="entrashift-audit.csv"',
    },
  });
});
