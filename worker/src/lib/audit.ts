/** Audit helper — append an administrative action to `audit_log` (SoW Phase 5). */

import type { AuditAction } from '@shared/contracts';
import * as auditDb from '../db/audit';
import { uuid } from './ids';
import { nowIso } from './time';

/**
 * Record an administrative action. Actor UPN comes from the authenticated session (UI) or a
 * fixed engine principal (VM). Never log secrets or message content.
 */
export async function audit(
  db: D1Database,
  actorUpn: string,
  action: AuditAction,
  target: string | null = null,
  detail: string | null = null,
): Promise<void> {
  await auditDb.insert(db, {
    id: uuid(),
    actorUpn,
    action,
    target,
    detail,
    createdAt: nowIso(),
  });
}
