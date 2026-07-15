/**
 * EntraShift control-plane Worker — entrypoint.
 *
 * Hono app: mounts `/auth` and `/api`; everything else falls through to the SPA (ASSETS).
 * A single global error handler emits the standard error envelope (api-spec).
 *
 * SECURITY POSTURE (enforced here + in middleware):
 *  - No secrets in any response. Tenant client secrets live only as AES-256-GCM ciphertext in D1;
 *    the master key is a Worker Secret and never leaves the isolate.
 *  - UI plane: Entra SSO session (HttpOnly/Secure/SameSite=Strict) + CSRF on writes.
 *  - VM plane: Cloudflare Access service-token assertion on every /api/vm/* request.
 *  - Free-tier governor: Queues carry dispatch only; all state via D1; ≤1 progress write/job/30s.
 */

import { Hono } from 'hono';
import type { AppEnv } from './env';
import { ApiError, type ErrorEnvelope } from './lib/errors';
import { countWorkerRequest } from './middleware/budget';
import { apiRouter, authRouter } from './routes';

const app = new Hono<AppEnv>();

// Count every /auth and /api request against the daily Workers budget (fire-and-forget).
app.use('/auth/*', countWorkerRequest);
app.use('/api/*', countWorkerRequest);

app.route('/auth', authRouter);
app.route('/api', apiRouter);

// SPA fallthrough. With `run_worker_first` scoped to /api/* and /auth/* in wrangler.jsonc, static
// asset requests normally bypass the Worker entirely; this keeps behaviour correct if they don't.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// Global error handler → standard envelope. Built with the Response constructor so the dynamic
// HTTP status maps cleanly (Hono's c.json narrows the status type).
function envelopeResponse(env: ErrorEnvelope, status: number): Response {
  return new Response(JSON.stringify(env), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

app.onError((error) => {
  if (error instanceof ApiError) {
    return envelopeResponse(error.toEnvelope(), error.status);
  }
  // Malformed JSON body etc. surface as a client validation error, not a 500.
  if (error instanceof SyntaxError) {
    return envelopeResponse({ error: { code: 'validation', message: 'Malformed request body' } }, 400);
  }
  // Unexpected: log server-side (never secrets) and return a generic envelope.
  console.error('Unhandled error:', error instanceof Error ? error.message : String(error));
  return envelopeResponse({ error: { code: 'internal', message: 'Internal server error' } }, 500);
});

export default app;
