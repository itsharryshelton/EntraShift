/**
 * Typed API client for the EntraShift control-plane Worker.
 *
 * Contract: shared/api-spec.md + shared/contracts.ts (imported below). Route
 * paths and body shapes here MUST match those files exactly so the UI, Worker,
 * and engine interoperate.
 *
 * SECURITY (org policy + SoW Phase 0):
 *   - Browser auth is a server-side session cookie (HttpOnly; Secure;
 *     SameSite=Strict). We therefore send `credentials: 'include'` and NEVER
 *     store any token in JS/localStorage — the front-end holds no secrets.
 *   - State-changing requests carry a CSRF token in the `X-CSRF-Token` header.
 *     The token is delivered by GET /api/me (readable by JS, but only usable by
 *     the same origin session) and refreshed on 403 `csrf`.
 *   - The UI never sees tenant client secrets or Graph tokens; those live only
 *     in the Worker (envelope-encrypted in D1).
 */

import type {
  MigrationUser,
  Job,
  AuditEntry,
  AuditAction,
  FreeTierBudget,
  PerUserReport,
  EngineConfig,
  TenantRole,
} from '@shared/contracts';

/* ------------------------------------------------------------------ *
 * Error envelope (api-spec.md "Standard error envelope")
 * ------------------------------------------------------------------ */

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'csrf'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'not_found'
  | 'validation'
  | 'graph_error'
  | 'token_error'
  | 'network' // client-synthesized: request never reached the Worker
  | 'unknown';

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: string };
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly detail?: string;
  constructor(code: ApiErrorCode, message: string, status: number, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ *
 * Session / CSRF (GET /api/me)
 * ------------------------------------------------------------------ */

export interface Me {
  upn: string;
  displayName: string;
  groupOk: boolean;
  /** CSRF token for state-changing requests (see security note above). */
  csrfToken: string;
}

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

let csrfToken: string | null = null;

function url(path: string): string {
  return `${API_BASE}${path}`;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Abort signal for cancellation / polling teardown. */
  signal?: AbortSignal;
  /** Set when we're retrying after refreshing the CSRF token (prevents loops). */
  _isRetry?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = (opts.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  // Attach CSRF token on state-changing calls (fetch it lazily if missing).
  if (UNSAFE_METHODS.has(method)) {
    if (!csrfToken && !opts._isRetry) {
      try {
        await getMe();
      } catch {
        /* getMe failure surfaces on the actual request below */
      }
    }
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }

  let res: Response;
  try {
    res = await fetch(url(path), {
      method,
      headers,
      credentials: 'include', // session cookie
      signal: opts.signal,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('network', 'Could not reach the control plane.', 0);
  }

  // 204 / empty
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const parsed = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const envelope = parsed as ApiErrorBody | undefined;
    const code = (envelope?.error?.code as ApiErrorCode) ?? httpToCode(res.status);
    const message = envelope?.error?.message ?? res.statusText ?? 'Request failed';

    // One transparent retry if the CSRF token went stale.
    if (code === 'csrf' && !opts._isRetry && UNSAFE_METHODS.has(method)) {
      csrfToken = null;
      await getMe().catch(() => undefined);
      return request<T>(path, { ...opts, _isRetry: true });
    }

    // Session expired → bounce to sign-in so the auth banner/redirect can show.
    if (code === 'unauthorized' && !path.startsWith('/api/me')) {
      window.dispatchEvent(new CustomEvent('entrashift:unauthorized'));
    }

    throw new ApiError(code, message, res.status, envelope?.error?.detail);
  }

  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function httpToCode(status: number): ApiErrorCode {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limited';
    default:
      return 'unknown';
  }
}

/* ------------------------------------------------------------------ *
 * Endpoint bindings — grouped to mirror api-spec.md
 * ------------------------------------------------------------------ */

/** GET /api/me — session identity + CSRF token. Caches the token module-side. */
export async function getMe(signal?: AbortSignal): Promise<Me> {
  const me = await request<Me>('/api/me', { signal });
  if (me?.csrfToken) csrfToken = me.csrfToken;
  return me;
}

/**
 * Public per-deployment branding (GET /api/app-info — no auth). One EntraShift Worker serves
 * ONE customer; this names which one, so the UI can make it obvious before and after sign-in.
 * Non-sensitive display data only.
 */
export interface AppInfo {
  projectName: string;
  product: string;
}
export function getAppInfo(signal?: AbortSignal): Promise<AppInfo> {
  return request<AppInfo>('/api/app-info', { signal });
}

/** Full-page redirect into the Entra SSO flow (api-spec: GET /auth/login). */
export function signInRedirect(): void {
  window.location.assign(url('/auth/login'));
}

export async function signOut(): Promise<void> {
  await request<void>('/auth/logout', { method: 'POST' });
  csrfToken = null;
}

/* ---- UI-facing tenant metadata (never plaintext secrets) ---- */
export interface TenantSummary {
  id: string;
  role: TenantRole;
  tenantId: string;
  clientId: string;
  displayName: string | null;
  secretExpiry: string | null; // ISO UTC
  status: 'disconnected' | 'connected' | 'error';
  lastTestedAt: string | null;
}

export interface ScopeCheck {
  scope: string;
  granted: boolean;
  purpose?: string;
}
export interface TenantTestResult {
  tokenAcquired: boolean;
  scopes: ScopeCheck[];
  missingConsents: string[];
  message?: string;
}

export const tenants = {
  list: (signal?: AbortSignal) => request<TenantSummary[]>('/api/tenants', { signal }),
  create: (body: {
    role: TenantRole;
    tenantId: string;
    clientId: string;
    clientSecret: string;
  }) => request<TenantSummary>('/api/tenants', { method: 'POST', body }),
  test: (id: string) =>
    request<TenantTestResult>(`/api/tenants/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),
  rotateSecret: (id: string, body: { clientSecret: string; secretExpiry?: string }) =>
    request<TenantSummary>(`/api/tenants/${encodeURIComponent(id)}/secret`, {
      method: 'POST',
      body,
    }),
  disconnect: (id: string) =>
    request<void>(`/api/tenants/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/* ---- Discovery & selection ---- */
export interface DiscoveredUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
  mail: string | null;
  accountEnabled: boolean;
}
export interface Paged<T> {
  items: T[];
  cursor: string | null;
}
export interface ImportResult {
  accepted: number;
  rejected: Array<{ line: number; reason: string; raw?: string }>;
}

export const discovery = {
  users: (params: { search?: string; cursor?: string } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.cursor) q.set('cursor', params.cursor);
    const qs = q.toString();
    return request<Paged<DiscoveredUser>>(
      `/api/discovery/users${qs ? `?${qs}` : ''}`,
      { signal },
    );
  },
};

export const migrationUsers = {
  list: (signal?: AbortSignal) =>
    request<MigrationUser[]>('/api/migration-users', { signal }),
  add: (users: Array<Partial<MigrationUser>>) =>
    request<MigrationUser[]>('/api/migration-users', { method: 'POST', body: users }),
  /** CSV import — sent as raw text body; Worker parses + validates line-by-line. */
  importCsv: (csv: string) =>
    request<ImportResult>('/api/migration-users/import', {
      method: 'POST',
      body: { csv },
    }),
  remove: (id: string) =>
    request<void>(`/api/migration-users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  updateMapping: (
    id: string,
    body: {
      targetEmail?: string | null;
      targetUpn?: string | null;
      mappingStatus: MigrationUser['mappingStatus'];
    },
  ) =>
    request<MigrationUser>(
      `/api/migration-users/${encodeURIComponent(id)}/mapping`,
      { method: 'PATCH', body },
    ),
};

/* ---- Provisioning ---- */
export interface ProvisionResult {
  provisioned: Array<{ migrationUserId: string; targetUpn: string }>;
  failed: Array<{ migrationUserId: string; reason: string }>;
  /** True once temp credentials exist and are pending a one-time CSV download. */
  credentialsPending: boolean;
}

export const provisioning = {
  provision: (migrationUserIds: string[]) =>
    request<ProvisionResult>('/api/provision', {
      method: 'POST',
      body: { migrationUserIds },
    }),
  /**
   * One-time temp-password CSV. Requires the acknowledge flag (§7.4). Returns
   * the CSV text; the Worker purges plaintext from D1 after serving it.
   */
  downloadPasswords: async (acknowledge: boolean): Promise<string> => {
    const res = await fetch(url(`/api/passwords/download?acknowledge=${acknowledge}`), {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'text/csv' },
    });
    if (!res.ok) {
      const body = safeJson(await res.text()) as ApiErrorBody | undefined;
      throw new ApiError(
        (body?.error?.code as ApiErrorCode) ?? httpToCode(res.status),
        body?.error?.message ?? 'Password download failed',
        res.status,
      );
    }
    return res.text();
  },
};

/* ---- Jobs / monitor ---- */
export const jobs = {
  create: (migrationUserIds: string[]) =>
    request<Job[]>('/api/jobs', { method: 'POST', body: { migrationUserIds } }),
  list: (signal?: AbortSignal) => request<Job[]>('/api/jobs', { signal }),
  get: (id: string, signal?: AbortSignal) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}`, { signal }),
  cancel: (id: string) =>
    request<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    }),
  retry: (id: string) =>
    request<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    }),
  delta: (id: string) =>
    request<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}/delta`, {
      method: 'POST',
    }),
};

/* ---- Reports / audit / budget / config ---- */
export const reports = {
  get: (migrationUserId: string, signal?: AbortSignal) =>
    request<PerUserReport>(
      `/api/reports/${encodeURIComponent(migrationUserId)}`,
      { signal },
    ),
  exportUrl: (migrationUserId: string) =>
    url(`/api/reports/${encodeURIComponent(migrationUserId)}/export`),
};

export interface AuditQuery {
  actor?: string;
  action?: AuditAction | '';
  from?: string;
  to?: string;
  cursor?: string;
}

export const audit = {
  list: (params: AuditQuery = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams();
    if (params.actor) q.set('actor', params.actor);
    if (params.action) q.set('action', params.action);
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    if (params.cursor) q.set('cursor', params.cursor);
    const qs = q.toString();
    return request<Paged<AuditEntry>>(`/api/audit${qs ? `?${qs}` : ''}`, { signal });
  },
  exportUrl: (params: AuditQuery = {}) => {
    const q = new URLSearchParams();
    if (params.actor) q.set('actor', params.actor);
    if (params.action) q.set('action', params.action);
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    const qs = q.toString();
    return url(`/api/audit/export${qs ? `?${qs}` : ''}`);
  },
};

export const budget = {
  get: (signal?: AbortSignal) => request<FreeTierBudget>('/api/budget', { signal }),
};

export const config = {
  get: (signal?: AbortSignal) => request<EngineConfig>('/api/config', { signal }),
  update: (patch: Partial<EngineConfig>) =>
    request<EngineConfig>('/api/config', { method: 'PATCH', body: patch }),
};

/* ------------------------------------------------------------------ *
 * Polling helper (SoW §1.1 / api-spec: UI polls, no websockets).
 * Default interval respects the 30s free-tier discipline; callers may relax
 * further. Stops on unmount via the returned disposer.
 * ------------------------------------------------------------------ */

export interface PollHandle {
  stop: () => void;
}

/**
 * Poll `fn` every `intervalMs` (default 30s). Fires immediately, then on the
 * interval. Skips overlapping runs. Never polls faster than 30s to honour the
 * Worker's server-side floor (SoW §1.1) — values below are clamped.
 */
export function poll<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  onResult: (result: T) => void,
  onError: (err: unknown) => void,
  intervalMs = 30_000,
): PollHandle {
  const interval = Math.max(30_000, intervalMs);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;

  const tick = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const result = await fn(controller.signal);
      if (!stopped) onResult(result);
    } catch (err) {
      if (!stopped && (err as Error).name !== 'AbortError') onError(err);
    } finally {
      if (!stopped) timer = setTimeout(tick, interval);
    }
  };

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    },
  };
}
