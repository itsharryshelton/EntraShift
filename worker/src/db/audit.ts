/** D1 access for `audit_log`. Append + filtered query + pruning (90-day retention). */

import type { AuditAction, AuditEntry } from '@shared/contracts';

interface AuditRowRaw {
  id: string;
  actor_upn: string;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: string;
}

function map(r: AuditRowRaw): AuditEntry {
  return {
    id: r.id,
    actorUpn: r.actor_upn,
    action: r.action as AuditAction,
    target: r.target,
    detail: r.detail,
    createdAt: r.created_at,
  };
}

export async function insert(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_upn, action, target, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(entry.id, entry.actorUpn, entry.action, entry.target, entry.detail, entry.createdAt)
    .run();
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  from?: string; // ISO
  to?: string; // ISO
  cursor?: string; // created_at of the last row from the previous page
  limit?: number;
}

/** Filterable, keyset-paginated query (newest first). Returns rows + next cursor. */
export async function query(db: D1Database, q: AuditQuery): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.actor) {
    where.push('actor_upn = ?');
    binds.push(q.actor);
  }
  if (q.action) {
    where.push('action = ?');
    binds.push(q.action);
  }
  if (q.from) {
    where.push('created_at >= ?');
    binds.push(q.from);
  }
  if (q.to) {
    where.push('created_at <= ?');
    binds.push(q.to);
  }
  if (q.cursor) {
    where.push('created_at < ?');
    binds.push(q.cursor);
  }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT ?`;
  binds.push(limit + 1);
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<AuditRowRaw>();

  const hasMore = results.length > limit;
  const page = results.slice(0, limit).map(map);
  const nextCursor = hasMore ? (page[page.length - 1]?.createdAt ?? null) : null;
  return { entries: page, nextCursor };
}

/** Delete rows older than the cutoff ISO timestamp. Returns rows removed. */
export async function pruneOlderThan(db: D1Database, cutoffIso: string): Promise<number> {
  const res = await db.prepare('DELETE FROM audit_log WHERE created_at < ?').bind(cutoffIso).run();
  return res.meta.changes ?? 0;
}
