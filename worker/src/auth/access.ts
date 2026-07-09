/**
 * Cloudflare Access service-token validation for the VM plane (`/api/vm/*`, SoW Phase 0).
 *
 * The Azure VM engine authenticates with a Cloudflare Access service token; Access injects a
 * signed `Cf-Access-Jwt-Assertion` header. We verify the JWT signature against the team-domain
 * JWKS and require `aud == CF_ACCESS_AUD` (the audience tag of the VM service-token app).
 *
 * NOTE: in a real deployment Cloudflare Access sits IN FRONT of the Worker and only forwards
 * requests that already carry a valid assertion; verifying here is defence in depth so the Worker
 * is safe even if fronting is misconfigured.
 */

import type { Env } from '../env';
import { err } from '../lib/errors';
import { verifyRs256 } from '../lib/jwt';

const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';

/**
 * Validate the Access assertion on the request. Returns the caller subject (service-token id /
 * common_name) for audit purposes. Throws unauthorized/forbidden on any failure.
 */
export async function validateAccessToken(env: Env, req: Request): Promise<string> {
  const token = req.headers.get(ACCESS_HEADER);
  if (!token) throw err.unauthorized('Missing Cloudflare Access assertion');

  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
  const claims = await verifyRs256(token, {
    jwksUri: `${teamDomain}/cdn-cgi/access/certs`,
    audience: env.CF_ACCESS_AUD,
    // Access issuer is the team domain; we pin audience explicitly and accept the team issuer.
    issuer: teamDomain,
  });

  // Service tokens surface as `common_name`; interactive users as `email`. Either identifies the caller.
  const subject =
    (claims['common_name'] as string) ?? (claims['email'] as string) ?? (claims['sub'] as string) ?? 'vm-engine';
  return subject;
}
