/** D1 access for `migration_users` — the selected/imported queue, mapping + workload flags. */

import type { MappingStatus, MigrationUser } from '@shared/contracts';

interface MigrationUserRowRaw {
  id: string;
  source_email: string;
  target_email: string | null;
  target_upn: string | null;
  migrate_exchange: number;
  migrate_onedrive: number;
  auto_create_target: number;
  include_archive: number;
  mapping_status: string;
  created_at: string;
}

function map(r: MigrationUserRowRaw): MigrationUser {
  return {
    id: r.id,
    sourceEmail: r.source_email,
    targetEmail: r.target_email,
    targetUpn: r.target_upn,
    migrateExchange: r.migrate_exchange === 1,
    migrateOneDrive: r.migrate_onedrive === 1,
    autoCreateTarget: r.auto_create_target === 1,
    includeArchive: r.include_archive === 1,
    mappingStatus: r.mapping_status as MappingStatus,
    createdAt: r.created_at,
  };
}

export async function list(db: D1Database): Promise<MigrationUser[]> {
  const { results } = await db.prepare('SELECT * FROM migration_users ORDER BY created_at').all<MigrationUserRowRaw>();
  return results.map(map);
}

export async function getById(db: D1Database, id: string): Promise<MigrationUser | null> {
  const raw = await db.prepare('SELECT * FROM migration_users WHERE id = ?').bind(id).first<MigrationUserRowRaw>();
  return raw ? map(raw) : null;
}

export async function listSourceEmails(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT source_email FROM migration_users').all<{ source_email: string }>();
  return results.map((r) => r.source_email);
}

export interface UpsertUserInput {
  id: string;
  sourceEmail: string;
  targetEmail: string | null;
  targetUpn: string | null;
  migrateExchange: boolean;
  migrateOneDrive: boolean;
  autoCreateTarget: boolean;
  includeArchive: boolean;
  mappingStatus: MappingStatus;
  createdAt: string;
}

/**
 * Insert (or update on duplicate source_email). Returns a prepared statement so callers can
 * batch many inserts into a single D1 `batch()` — one write op for a bulk import.
 */
export function upsertStmt(db: D1Database, u: UpsertUserInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO migration_users
         (id, source_email, target_email, target_upn, migrate_exchange, migrate_onedrive,
          auto_create_target, include_archive, mapping_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_email) DO UPDATE SET
         target_email = excluded.target_email,
         target_upn = excluded.target_upn,
         migrate_exchange = excluded.migrate_exchange,
         migrate_onedrive = excluded.migrate_onedrive,
         auto_create_target = excluded.auto_create_target,
         include_archive = excluded.include_archive,
         mapping_status = excluded.mapping_status`,
    )
    .bind(
      u.id,
      u.sourceEmail,
      u.targetEmail,
      u.targetUpn,
      u.migrateExchange ? 1 : 0,
      u.migrateOneDrive ? 1 : 0,
      u.autoCreateTarget ? 1 : 0,
      u.includeArchive ? 1 : 0,
      u.mappingStatus,
      u.createdAt,
    );
}

export async function updateMapping(
  db: D1Database,
  id: string,
  fields: { targetEmail: string | null; targetUpn: string | null; mappingStatus: MappingStatus },
): Promise<void> {
  await db
    .prepare('UPDATE migration_users SET target_email = ?, target_upn = ?, mapping_status = ? WHERE id = ?')
    .bind(fields.targetEmail, fields.targetUpn, fields.mappingStatus, id)
    .run();
}

export async function setMappingStatus(db: D1Database, id: string, status: MappingStatus): Promise<void> {
  await db.prepare('UPDATE migration_users SET mapping_status = ? WHERE id = ?').bind(status, id).run();
}

export async function remove(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM migration_users WHERE id = ?').bind(id).run();
}
