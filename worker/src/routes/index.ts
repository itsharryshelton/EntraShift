/**
 * Router wiring.
 *
 * Two planes (api-spec auth model):
 *   - UI plane   (`/api/*` except `/api/vm/*`): Entra SSO session + CSRF + per-session rate limit.
 *   - VM plane   (`/api/vm/*`): Cloudflare Access service-token assertion.
 * Both apply the free-tier `budgetGuard` (state-changing requests refused once a hard cap is hit).
 *
 * IMPORTANT: a root wildcard (`use('*')`) matches EVERY path, including `/api/vm/*`. So the UI guard
 * explicitly short-circuits VM paths (which have their own path-scoped Access guard) — otherwise it
 * would wrongly demand a session cookie from the engine. Middleware is registered before routes.
 *
 * `/auth/*` is exported separately (login/callback are the only session-less routes).
 */

import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { requireSession } from '../middleware/session';
import { requireAccessToken } from '../middleware/vm';
import { rateLimit } from '../middleware/ratelimit';
import { budgetGuard } from '../middleware/budget';

import { authRouter } from './auth';
import { tenantsRouter } from './tenants';
import { discoveryRouter } from './discovery';
import { usersRouter } from './users';
import { mappingRouter } from './mapping';
import { provisionRouter } from './provision';
import { passwordsRouter } from './passwords';
import { jobsRouter } from './jobs';
import { reportsRouter } from './reports';
import { auditRouter } from './audit';
import { budgetRouter } from './budget';
import { configRouter } from './config';
import { vmRouter } from './vm';

export { authRouter };

const VM_PREFIX = '/api/vm';

export const apiRouter = new Hono<AppEnv>();

/* --------------------------- Middleware (registered first) --------------------------- */

// VM plane: path-scoped Access guard + budget guard.
apiRouter.use('/vm/*', requireAccessToken);
apiRouter.use('/vm/*', budgetGuard);

// UI plane: applies to everything EXCEPT the VM plane. Composes session+CSRF → rate limit → budget.
apiRouter.use(
  '*',
  createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.path.startsWith(VM_PREFIX)) return next(); // VM plane is guarded above
    if (c.req.path === '/api/app-info') return next(); // public branding (no secrets) — pre-auth
    // Compose session+CSRF → rate limit → budget guard, then the route handler (`next`).
    await requireSession(c, async () => {
      await rateLimit(c, async () => {
        await budgetGuard(c, next);
      });
    });
  }),
);

/* --------------------------------- Routes ---------------------------------- */

// GET /api/app-info — PUBLIC (pre-auth) branding for this deployment. NON-SENSITIVE only:
// the per-customer PROJECT_NAME + product name, so the UI can make the target obvious before
// and after sign-in. One Worker per customer, so this identifies which instance you're on.
apiRouter.get('/app-info', (c) => {
  return c.json({ projectName: c.env.PROJECT_NAME || 'EntraShift', product: 'EntraShift' });
});

// GET /api/me — current session identity + the CSRF token the client echoes on writes.
apiRouter.get('/me', (c) => {
  const s = c.get('session');
  return c.json({ upn: s.actorUpn, displayName: s.displayName, groupOk: s.groupOk, csrfToken: s.csrfToken });
});

apiRouter.route('/tenants', tenantsRouter);
apiRouter.route('/discovery', discoveryRouter);
apiRouter.route('/migration-users', usersRouter);
apiRouter.route('/migration-users', mappingRouter); // adds PATCH /:id/mapping
apiRouter.route('/provision', provisionRouter);
apiRouter.route('/passwords', passwordsRouter);
apiRouter.route('/jobs', jobsRouter);
apiRouter.route('/reports', reportsRouter);
apiRouter.route('/audit', auditRouter);
apiRouter.route('/budget', budgetRouter);
apiRouter.route('/config', configRouter);
apiRouter.route('/vm', vmRouter);
