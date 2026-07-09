/**
 * EntraShift Worker — binding + secret + var surface.
 *
 * Mirrors `wrangler.jsonc`:
 *   - bindings: DB (D1), JOB_QUEUE (Queues producer — dispatch ONLY), ASSETS (SPA static)
 *   - secrets:  MASTER_ENCRYPTION_KEY, OIDC_CLIENT_SECRET (set via `wrangler secret put`)
 *   - vars:     OIDC / Entra SSO config, Cloudflare Access config, poll floor
 *
 * SECURITY: the two secrets are the only long-lived credentials the control plane holds.
 * MASTER_ENCRYPTION_KEY never leaves the Worker; tenant client secrets are only ever stored
 * as AES-256-GCM ciphertext in D1 and decrypted transiently in memory.
 */

import type { JobDispatchMessage } from '@shared/contracts';
import type { SessionRecord } from './db/sessions';

export interface Env {
  // --- Bindings ---
  DB: D1Database;
  /** Job dispatch ONLY — one tiny message per user+workload. All state flows via D1. */
  JOB_QUEUE: Queue<JobDispatchMessage>;
  /** Built React SPA (web/dist). Everything not /api or /auth falls through to here. */
  ASSETS: Fetcher;

  // --- Secrets (wrangler secret put; NEVER in source) ---
  /** base64 32-byte AES-256 key. Envelope master for tenant secrets + temp passwords. */
  MASTER_ENCRYPTION_KEY: string;
  /** UI (MSP-tenant) app-registration client secret for the OIDC auth-code flow. */
  OIDC_CLIENT_SECRET: string;

  // --- Vars ---
  /**
   * Customer/engagement label for THIS deployment. One Worker per customer (no mixing).
   * Shown prominently in the UI (topbar, sign-in, document title) via public GET /api/app-info.
   */
  PROJECT_NAME: string;
  ENTRA_TENANT_ID: string;
  OIDC_CLIENT_ID: string;
  OIDC_REDIRECT_URI: string;
  ALLOWED_GROUP_ID: string;
  SESSION_TTL_SECONDS: string;
  MIN_POLL_INTERVAL_SEC: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;

  /**
   * ⚠️ DEV ONLY. When exactly "true" AND the request is on localhost, the Entra SSO handshake
   * is bypassed and a synthetic local session is minted (see auth/devbypass.ts). Set ONLY in
   * `.dev.vars`; NEVER add to wrangler.jsonc vars or set as a production Worker Secret. Absent
   * (undefined) in every real deployment → bypass impossible.
   */
  DEV_AUTH_BYPASS?: string;
}

/** Per-request context values set by middleware. */
export interface Variables {
  /** Authenticated engineer session (set by requireSession on UI routes). */
  session: SessionRecord;
  /** Cloudflare Access subject (set by requireAccessToken on /api/vm/*). */
  accessSubject: string;
}

/** Hono generic bundle used across the app. */
export type AppEnv = { Bindings: Env; Variables: Variables };
