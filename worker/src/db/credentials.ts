/**
 * D1 access for `provisioned_credentials` — temporary provisioning passwords.
 *
 * SECURITY (SoW Phase 3): passwords are envelope-encrypted (AES-256-GCM under the master key)
 * and held ONLY until the one-time CSV download, then the ciphertext is purged (nulled). Every
 * provisioned account is force-change-at-next-sign-in so the exposure window is a single sign-in.
 */

interface CredRowRaw {
  id: string;
  migration_user_id: string;
  target_upn: string;
  password_ciphertext: string | null;
  password_iv: string | null;
  created_at: string;
  downloaded_at: string | null;
}

export interface PendingCredential {
  id: string;
  migrationUserId: string;
  targetUpn: string;
  ciphertext: string;
  iv: string;
}

export async function insert(
  db: D1Database,
  c: { id: string; migrationUserId: string; targetUpn: string; ciphertext: string; iv: string; createdAt: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provisioned_credentials (id, migration_user_id, target_upn, password_ciphertext, password_iv, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(c.id, c.migrationUserId, c.targetUpn, c.ciphertext, c.iv, c.createdAt)
    .run();
}

/** All credentials still holding ciphertext and not yet downloaded (the one-time set). */
export async function listPending(db: D1Database): Promise<PendingCredential[]> {
  const { results } = await db
    .prepare(
      `SELECT id, migration_user_id, target_upn, password_ciphertext, password_iv
       FROM provisioned_credentials
       WHERE downloaded_at IS NULL AND password_ciphertext IS NOT NULL
       ORDER BY created_at`,
    )
    .all<CredRowRaw>();
  return results.map((r) => ({
    id: r.id,
    migrationUserId: r.migration_user_id,
    targetUpn: r.target_upn,
    ciphertext: r.password_ciphertext!,
    iv: r.password_iv!,
  }));
}

/** Count of credentials awaiting the one-time download (drives the UI gate). */
export async function countPending(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM provisioned_credentials WHERE downloaded_at IS NULL AND password_ciphertext IS NOT NULL',
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Mark downloaded and PURGE the ciphertext + IV in one write. Post-download it is unrecoverable.
 *
 * NOTE: `password_ciphertext`/`password_iv` are declared NOT NULL in the schema (0001_init.sql),
 * so we OVERWRITE them with the empty string rather than setting NULL (a NULL would raise a
 * NOT NULL constraint violation and abort the purge). Overwriting still destroys the ciphertext;
 * `downloaded_at` is the authoritative "already delivered" gate used by listPending/countPending.
 */
export async function markDownloadedAndPurge(db: D1Database, ids: string[], downloadedAt: string): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await db
    .prepare(
      `UPDATE provisioned_credentials
       SET downloaded_at = ?, password_ciphertext = '', password_iv = ''
       WHERE id IN (${placeholders})`,
    )
    .bind(downloadedAt, ...ids)
    .run();
}
