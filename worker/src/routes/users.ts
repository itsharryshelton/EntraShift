/**
 * Migration-user queue (`/api/migration-users`, SoW Phase 2).
 * Ad-hoc selection, bulk CSV import (line-level validation), listing, removal.
 */

import { Hono } from 'hono';
import type { MappingStatus, MigrationUser } from '@shared/contracts';
import type { AppEnv } from '../env';
import { err } from '../lib/errors';
import { uuid } from '../lib/ids';
import { nowIso } from '../lib/time';
import { billUsage } from '../lib/budget';
import { audit } from '../lib/audit';
import { validateImportCsv } from '../lib/csv';
import * as usersDb from '../db/migrationUsers';

export const usersRouter = new Hono<AppEnv>();

/** Derive the initial mapping status from the workload/target flags. */
function deriveMappingStatus(u: { targetEmail: string | null; autoCreateTarget: boolean }): MappingStatus {
  if (u.autoCreateTarget) return 'auto_create';
  if (u.targetEmail) return 'mapped';
  return 'unmapped';
}

/** GET /api/migration-users — list the queue. */
usersRouter.get('/', async (c) => {
  return c.json(await usersDb.list(c.env.DB));
});

/** POST /api/migration-users — add selected users (partial MigrationUser[]). */
usersRouter.post('/', async (c) => {
  // api-spec documents the body as a (partial) `MigrationUser[]`; we also accept `{ users: [...] }`
  // so both a spec-literal array and the wrapped form interoperate.
  const raw = await c.req.json<Array<Partial<MigrationUser>> | { users?: Array<Partial<MigrationUser>> }>();
  const input = Array.isArray(raw) ? raw : (raw.users ?? []);
  if (!Array.isArray(input) || input.length === 0) throw err.validation('a non-empty MigrationUser[] (or { users: [...] }) is required');

  const now = nowIso();
  const stmts = input.map((u) => {
    if (!u.sourceEmail) throw err.validation('each user requires sourceEmail');
    const targetEmail = u.targetEmail ?? null;
    const autoCreateTarget = Boolean(u.autoCreateTarget);
    return usersDb.upsertStmt(c.env.DB, {
      id: u.id ?? uuid(),
      sourceEmail: u.sourceEmail,
      targetEmail,
      targetUpn: u.targetUpn ?? null,
      migrateExchange: Boolean(u.migrateExchange),
      migrateOneDrive: Boolean(u.migrateOneDrive),
      autoCreateTarget,
      includeArchive: Boolean(u.includeArchive),
      mappingStatus: u.mappingStatus ?? deriveMappingStatus({ targetEmail, autoCreateTarget }),
      createdAt: now,
    });
  });
  await c.env.DB.batch(stmts);
  billUsage(c.executionCtx, c.env, { d1Writes: stmts.length });

  await audit(c.env.DB, c.get('session').actorUpn, 'user_select', null, `added ${stmts.length} user(s)`);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  return c.json(await usersDb.list(c.env.DB), 201);
});

/** POST /api/migration-users/import — CSV upload with line-level validation. */
usersRouter.post('/import', async (c) => {
  const csvText = await c.req.text();
  if (!csvText.trim()) throw err.validation('Empty CSV body');

  const existing = await usersDb.listSourceEmails(c.env.DB);
  const { accepted, rejected } = validateImportCsv(csvText, { existingSourceEmails: existing });

  if (accepted.length > 0) {
    const now = nowIso();
    const stmts = accepted.map((r) =>
      usersDb.upsertStmt(c.env.DB, {
        id: uuid(),
        sourceEmail: r.sourceEmail,
        targetEmail: r.targetEmail,
        targetUpn: null, // resolved later in the mapping step
        migrateExchange: r.migrateExchange,
        migrateOneDrive: r.migrateOneDrive,
        autoCreateTarget: r.autoCreateTarget,
        includeArchive: false,
        mappingStatus: deriveMappingStatus({ targetEmail: r.targetEmail, autoCreateTarget: r.autoCreateTarget }),
        createdAt: now,
      }),
    );
    await c.env.DB.batch(stmts);
    billUsage(c.executionCtx, c.env, { d1Writes: stmts.length });
  }

  await audit(
    c.env.DB,
    c.get('session').actorUpn,
    'csv_import',
    null,
    `accepted ${accepted.length}, rejected ${rejected.length}`,
  );
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  // Shape matches api-spec: { accepted, rejected: [{ line, reason }] }.
  return c.json({ accepted: accepted.length, rejected });
});

/** DELETE /api/migration-users/:id — remove from queue. */
usersRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await usersDb.getById(c.env.DB, id);
  if (!existing) throw err.notFound('Migration user not found');

  await usersDb.remove(c.env.DB, id);
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  await audit(c.env.DB, c.get('session').actorUpn, 'user_select', existing.sourceEmail, 'removed');
  billUsage(c.executionCtx, c.env, { d1Writes: 1 });

  return c.json({ ok: true });
});
