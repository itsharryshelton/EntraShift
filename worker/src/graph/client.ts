/**
 * WORKER-SIDE Microsoft Graph client.
 *
 * The Worker holds the ONLY copy of tenant client secrets (envelope-encrypted in D1). It:
 *   - runs the OAuth2 client-credentials flow per tenant (app-only, `.default` scope),
 *   - performs directory discovery + provisioning inline (light, no bulk data),
 *   - hands the VM engine SHORT-LIVED Graph access tokens (see routes/vm.ts).
 *
 * The engine NEVER receives a tenant client secret — only transient access tokens.
 * SECURITY: tokens/secrets are never logged; Graph error bodies are surfaced without echoing auth.
 *
 * Least-privilege application permissions per role (SoW Phase 1). Directory.ReadWrite.All is
 * deliberately EXCLUDED in favour of the narrower User.ReadWrite.All.
 */

import type { TenantRole } from '@shared/contracts';
import { err } from '../lib/errors';
import { decodeJwt } from '../lib/jwt';

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';

/** Required application permissions per tenant role (the connection test probes these). */
export const REQUIRED_SCOPES: Record<TenantRole, string[]> = {
  source: ['User.Read.All', 'MailboxItem.Export.All', 'MailboxFolder.Read.All', 'MailboxSettings.Read', 'Files.Read.All'],
  destination: [
    'User.ReadWrite.All',
    'MailboxItem.ImportExport.All',
    'MailboxFolder.ReadWrite.All',
    'Files.ReadWrite.All',
    'Sites.FullControl.All',
  ],
};

export interface AppToken {
  accessToken: string;
  expiresAt: string; // ISO-8601 UTC
}

/** Client-credentials token acquisition. Plaintext secret used transiently, never stored/logged. */
export async function acquireAppToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  scope: string = DEFAULT_SCOPE,
): Promise<AppToken> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope,
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !json.access_token) {
    throw err.token('Graph client-credentials token acquisition failed', json.error_description ?? json.error ?? `HTTP ${res.status}`);
  }
  const expiresIn = json.expires_in ?? 3600;
  // Shave 60s so the engine never uses a token within a minute of expiry.
  return { accessToken: json.access_token, expiresAt: new Date(Date.now() + (expiresIn - 60) * 1000).toISOString() };
}

/** The application permissions actually granted appear as `roles` in the app-only access token. */
export function grantedRoles(accessToken: string): string[] {
  try {
    const { claims } = decodeJwt(accessToken);
    const roles = (claims as { roles?: unknown }).roles;
    return Array.isArray(roles) ? roles.map(String) : [];
  } catch {
    return [];
  }
}

export interface ConnectionTestResult {
  tokenAcquired: boolean;
  tenantId: string;
  scopes: Array<{ scope: string; granted: boolean }>;
  missingConsents: string[];
  error?: string;
}

/**
 * Acquire an app-only token and report per-scope pass/fail + missing admin consents, by inspecting
 * the `roles` claim (the authoritative record of which application permissions were consented).
 */
export async function testConnection(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  role: TenantRole,
): Promise<ConnectionTestResult> {
  const required = REQUIRED_SCOPES[role];
  try {
    const token = await acquireAppToken(tenantId, clientId, clientSecret);
    const roles = grantedRoles(token.accessToken);
    const scopes = required.map((scope) => ({ scope, granted: roles.includes(scope) }));
    const missingConsents = scopes.filter((s) => !s.granted).map((s) => s.scope);
    return { tokenAcquired: true, tenantId, scopes, missingConsents };
  } catch (e) {
    // Token itself failed (bad secret, wrong tenant/client, or no consent at all).
    const detail = e instanceof Error ? e.message : 'unknown error';
    return {
      tokenAcquired: false,
      tenantId,
      scopes: required.map((scope) => ({ scope, granted: false })),
      missingConsents: required,
      error: detail,
    };
  }
}

async function graphGet<T>(accessToken: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw err.graph(`Graph GET ${new URL(url).pathname} failed (${res.status})`, text.slice(0, 500));
  }
  return (await res.json()) as T;
}

export interface GraphUser {
  id: string;
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  userPrincipalName: string;
  mail: string | null;
  accountEnabled: boolean;
}

interface GraphUserList {
  value: GraphUser[];
  '@odata.nextLink'?: string;
}

const USER_SELECT = 'id,displayName,givenName,surname,userPrincipalName,mail,accountEnabled';

/** Live source-directory discovery, paginated. `cursor` is an opaque $skiptoken. */
export async function discoverUsers(
  accessToken: string,
  opts: { search?: string; cursor?: string; pageSize?: number } = {},
): Promise<{ users: GraphUser[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  params.set('$select', USER_SELECT);
  params.set('$top', String(opts.pageSize ?? 25));
  if (opts.search) {
    const s = opts.search.replace(/'/g, "''"); // escape single quotes for OData
    params.set('$filter', `startswith(displayName,'${s}') or startswith(userPrincipalName,'${s}') or startswith(mail,'${s}')`);
  }
  if (opts.cursor) params.set('$skiptoken', opts.cursor);

  const data = await graphGet<GraphUserList>(accessToken, `${GRAPH}/users?${params.toString()}`);
  let nextCursor: string | null = null;
  const next = data['@odata.nextLink'];
  if (next) nextCursor = new URL(next).searchParams.get('$skiptoken');
  return { users: data.value, nextCursor };
}

/** Look up a single source user by mail or UPN (for provisioning metadata). */
export async function getUserByEmail(accessToken: string, email: string): Promise<GraphUser | null> {
  const s = email.replace(/'/g, "''");
  const url = `${GRAPH}/users?$select=${USER_SELECT}&$filter=mail eq '${s}' or userPrincipalName eq '${s}'&$top=1`;
  const data = await graphGet<GraphUserList>(accessToken, url);
  return data.value[0] ?? null;
}

export interface ProvisionInput {
  userPrincipalName: string;
  displayName: string;
  givenName: string | null;
  surname: string | null;
  mailNickname: string;
  password: string;
}

/**
 * Create a destination user (User.ReadWrite.All) with a forced password change at next sign-in.
 * The random temp password is supplied by the caller (generated + envelope-encrypted upstream).
 */
export async function provisionUser(accessToken: string, input: ProvisionInput): Promise<{ id: string; userPrincipalName: string }> {
  const res = await fetch(`${GRAPH}/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      accountEnabled: true,
      displayName: input.displayName,
      givenName: input.givenName,
      surname: input.surname,
      mailNickname: input.mailNickname,
      userPrincipalName: input.userPrincipalName,
      passwordProfile: { password: input.password, forceChangePasswordNextSignIn: true },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw err.graph(`Provisioning ${input.userPrincipalName} failed (${res.status})`, text.slice(0, 500));
  }
  const json = (await res.json()) as { id: string; userPrincipalName: string };
  return { id: json.id, userPrincipalName: json.userPrincipalName };
}

/**
 * Trigger OneDrive personal-site pre-provisioning. Reading the user's drive root causes SharePoint
 * to provision the site for a licensed user. Best-effort: a not-yet-licensed user returns an error
 * we swallow (the engine retries later). PROTOTYPE: for guaranteed pre-provisioning use the
 * SharePoint Admin `SPHostedSharePointSitesRequest` endpoint — documented in the deployment guide.
 */
export async function preProvisionOneDrive(accessToken: string, userId: string): Promise<boolean> {
  try {
    await graphGet(accessToken, `${GRAPH}/users/${encodeURIComponent(userId)}/drive/root`);
    return true;
  } catch {
    return false;
  }
}
