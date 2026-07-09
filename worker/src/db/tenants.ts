/**
 * D1 access for `tenants`. Holds the AES-256-GCM ciphertext of each tenant client secret.
 *
 * SECURITY: the public-facing record (`TenantRecord`) intentionally OMITS the ciphertext and IV.
 * Only `getSecretMaterial` returns them, and only server-side code that immediately decrypts to
 * acquire a Graph token ever calls it. Secret plaintext is never stored and never surfaced.
 */

import type { TenantRole } from '@shared/contracts';

export type TenantStatus = 'disconnected' | 'connected' | 'error';

/** UI-safe tenant metadata — NO secret material. */
export interface TenantRecord {
  id: string;
  role: TenantRole;
  tenantId: string;
  clientId: string;
  /** Secret expiry date (ISO-8601 UTC) for display only. The secret itself is never returned. */
  secretExpiry: string | null;
  displayName: string | null;
  status: TenantStatus;
  lastTestedAt: string | null;
  createdAt: string;
}

interface TenantRowRaw {
  id: string;
  role: string;
  tenant_id: string;
  client_id: string;
  secret_ciphertext: string;
  secret_iv: string;
  secret_expiry: string | null;
  display_name: string | null;
  status: string;
  last_tested_at: string | null;
  created_at: string;
}

function mapPublic(r: TenantRowRaw): TenantRecord {
  return {
    id: r.id,
    role: r.role as TenantRole,
    tenantId: r.tenant_id,
    clientId: r.client_id,
    secretExpiry: r.secret_expiry,
    displayName: r.display_name,
    status: r.status as TenantStatus,
    lastTestedAt: r.last_tested_at,
    createdAt: r.created_at,
  };
}

export async function list(db: D1Database): Promise<TenantRecord[]> {
  const { results } = await db.prepare('SELECT * FROM tenants ORDER BY role').all<TenantRowRaw>();
  return results.map(mapPublic);
}

export async function getById(db: D1Database, id: string): Promise<TenantRecord | null> {
  const raw = await db.prepare('SELECT * FROM tenants WHERE id = ?').bind(id).first<TenantRowRaw>();
  return raw ? mapPublic(raw) : null;
}

export async function getByRole(db: D1Database, role: TenantRole): Promise<TenantRecord | null> {
  const raw = await db.prepare('SELECT * FROM tenants WHERE role = ?').bind(role).first<TenantRowRaw>();
  return raw ? mapPublic(raw) : null;
}

export interface SecretMaterial {
  id: string;
  tenantId: string;
  clientId: string;
  ciphertext: string;
  iv: string;
}

/** Secret material for transient decryption ONLY. Never return this to the browser. */
export async function getSecretMaterial(db: D1Database, role: TenantRole): Promise<SecretMaterial | null> {
  const raw = await db
    .prepare('SELECT id, tenant_id, client_id, secret_ciphertext, secret_iv FROM tenants WHERE role = ?')
    .bind(role)
    .first<Pick<TenantRowRaw, 'id' | 'tenant_id' | 'client_id' | 'secret_ciphertext' | 'secret_iv'>>();
  if (!raw) return null;
  return { id: raw.id, tenantId: raw.tenant_id, clientId: raw.client_id, ciphertext: raw.secret_ciphertext, iv: raw.secret_iv };
}

/** As above, keyed by tenant row id (used by the connection-test route). */
export async function getSecretMaterialById(db: D1Database, id: string): Promise<SecretMaterial | null> {
  const raw = await db
    .prepare('SELECT id, tenant_id, client_id, secret_ciphertext, secret_iv FROM tenants WHERE id = ?')
    .bind(id)
    .first<Pick<TenantRowRaw, 'id' | 'tenant_id' | 'client_id' | 'secret_ciphertext' | 'secret_iv'>>();
  if (!raw) return null;
  return { id: raw.id, tenantId: raw.tenant_id, clientId: raw.client_id, ciphertext: raw.secret_ciphertext, iv: raw.secret_iv };
}

export interface UpsertTenantInput {
  id: string;
  role: TenantRole;
  tenantId: string;
  clientId: string;
  secretCiphertext: string;
  secretIv: string;
  secretExpiry: string | null;
  displayName: string | null;
  createdAt: string;
}

/** Insert or replace the single tenant for a role (schema enforces UNIQUE(role)). */
export async function upsert(db: D1Database, t: UpsertTenantInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tenants (id, role, tenant_id, client_id, secret_ciphertext, secret_iv, secret_expiry, display_name, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'disconnected', ?)
       ON CONFLICT(role) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         client_id = excluded.client_id,
         secret_ciphertext = excluded.secret_ciphertext,
         secret_iv = excluded.secret_iv,
         secret_expiry = excluded.secret_expiry,
         display_name = excluded.display_name,
         status = 'disconnected'`,
    )
    .bind(t.id, t.role, t.tenantId, t.clientId, t.secretCiphertext, t.secretIv, t.secretExpiry, t.displayName, t.createdAt)
    .run();
}

/** Rotate only the encrypted secret + expiry (re-entry required; no reveal). */
export async function rotateSecret(
  db: D1Database,
  id: string,
  ciphertext: string,
  iv: string,
  secretExpiry: string | null,
): Promise<void> {
  await db
    .prepare('UPDATE tenants SET secret_ciphertext = ?, secret_iv = ?, secret_expiry = ?, status = ? WHERE id = ?')
    .bind(ciphertext, iv, secretExpiry, 'disconnected', id)
    .run();
}

export async function setStatus(db: D1Database, id: string, status: TenantStatus, lastTestedAt: string | null): Promise<void> {
  await db
    .prepare('UPDATE tenants SET status = ?, last_tested_at = COALESCE(?, last_tested_at) WHERE id = ?')
    .bind(status, lastTestedAt, id)
    .run();
}

export async function remove(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM tenants WHERE id = ?').bind(id).run();
}
