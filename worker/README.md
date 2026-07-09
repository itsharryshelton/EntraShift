# EntraShift — Control Plane (Cloudflare Worker)

TypeScript · [Hono](https://hono.dev) · Cloudflare Workers (D1 + Queues producer + static ASSETS).

The control plane is the light, edge half of EntraShift: Web UI/API, Entra ID SSO, tenant-secret
envelope encryption, D1 job state, one-message-per-job Queue dispatch, VM authentication, and the
free-tier budget governor. **No mailbox/file bytes ever flow through the Worker** — heavy lifting is
the Azure VM engine's job (see [`../engine`](../engine)).

---

## Architecture (this component)

```
src/
  index.ts            Hono app; mounts /auth + /api; SPA fallthrough to ASSETS; global error envelope
  env.ts              Env bindings/secrets/vars + per-request Variables
  lib/
    crypto.ts         AES-256-GCM envelope encrypt/decrypt + temp-password generator
    jwt.ts            RS256 JWKS verification (OIDC id_token + Cloudflare Access)
    csv.ts            CSV parse/serialise + bulk-import validator
    errors.ts         ApiError + standard error envelope
    audit.ts          audit_log append
    budget.ts         free-tier governor (counters, degrade, paused, billing helper)
    ids.ts / time.ts  uuid/opaque tokens/hashing · ISO-8601 UTC helpers
  db/                 typed D1 query modules (camelCased records matching contracts.ts)
  auth/
    oidc.ts           PKCE (S256), authorize URL, code exchange, id_token + group-claim validation
    session.ts        server-side sessions (HttpOnly/Secure/SameSite=Strict, ≤8h) + CSRF token
    access.ts         Cf-Access-Jwt-Assertion validation for /api/vm/*
  middleware/         session+CSRF · Access token · per-session rate limit · budget guard + 30s floor
  graph/client.ts     Worker-side Graph: client-credentials tokens, discovery, connection test,
                      provisioning, OneDrive pre-provisioning
  routes/             one module per api-spec section, wired in routes/index.ts
test/                 crypto round-trip + CSV validation (Vitest, workers pool)
```

The HTTP contract implemented here is [`../shared/api-spec.md`](../shared/api-spec.md); the record
shapes are [`../shared/contracts.ts`](../shared/contracts.ts). Both are the source of truth — this
Worker matches them exactly so the VM engine and Web UI interoperate.

## Configure

1. **D1** - create the database and set its id in `wrangler.jsonc`:
   ```sh
   wrangler d1 create entrashift          # copy database_id into wrangler.jsonc
   wrangler d1 migrations apply entrashift # local
   npm run db:migrate:remote               # remote
   ```
2. **Queue**:
   ```sh
   wrangler queues create entrashift-jobs
   ```
3. **Vars** - fill the placeholders in `wrangler.jsonc` (`ENTRA_TENANT_ID`, `OIDC_CLIENT_ID`,
   `OIDC_REDIRECT_URI`, `ALLOWED_GROUP_ID`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, …).
4. **Secrets** (never committed):
   ```sh
   # 32-byte AES-256 master key, base64:
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" | wrangler secret put MASTER_ENCRYPTION_KEY
   wrangler secret put OIDC_CLIENT_SECRET
   ```
   For local dev, copy `.dev.vars.example` → `.dev.vars`.
5. **Entra app registration (UI SSO)** — OIDC auth-code + PKCE, redirect URI = `OIDC_REDIRECT_URI`,
   delegated `openid profile email` only, and configure `groupMembershipClaims` to emit the MSP
   security group so the `groups` claim carries `ALLOWED_GROUP_ID` (use a group-filtered assignment
   for large directories to avoid claim overage).
6. **Cloudflare Access** — protect `/api/vm/*` with a service-token application; set `CF_ACCESS_AUD`
   to that app's audience tag and `CF_ACCESS_TEAM_DOMAIN` to your team domain.

## Develop / test / deploy

```sh
npm install          # (run by you; this component does not run installs for you)
npm run typecheck
npm test             # Vitest (crypto round-trip + CSV validation), runs in the workers pool
npm run dev          # wrangler dev
npm run deploy       
```

## Notes / assumptions

- The Web UI build (`../web/dist`) is served via the `ASSETS` binding with SPA fallback; build the
  UI before deploying.
- `itemsSucceeded` in reports is derived (`progressCurrent − skipped − failed`, floored at 0).
- OneDrive pre-provisioning uses a drive-root touch as a best-effort trigger; guaranteed
  pre-provisioning via the SharePoint Admin API is documented for the deployment guide.
- The Workers-request budget counter is one D1 write per request (accepted cost of a D1-backed
  counter on the free tier); a production build could sample/aggregate.
