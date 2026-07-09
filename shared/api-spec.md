# EntraShift — Worker ↔ Engine / UI API contract

This is the authoritative HTTP contract. Type shapes referenced below (`VmTokenRequest`,
`ProgressUpdate`, …) are defined in [`contracts.ts`](./contracts.ts) and mirrored in
[`engine/entrashift_engine/contracts.py`](../engine/entrashift_engine/contracts.py).

All timestamps are ISO-8601 **UTC**. All request/response bodies are JSON unless noted.

## Auth model — two planes

| Caller | Mechanism | Applies to |
| :--- | :--- | :--- |
| **Engineer browser** | Entra ID SSO (OIDC Auth-Code + PKCE) → server-side session cookie (`HttpOnly; Secure; SameSite=Strict`). CSRF token required on state-changing routes. | `/auth/*`, `/api/*` (except `/api/vm/*`) |
| **Azure VM engine** | Cloudflare Access **service token** → Worker validates `Cf-Access-Jwt-Assertion` on every request. | `/api/vm/*` only |
| **VM → Queues** | Cloudflare API token scoped `queues:read`/consume — **direct to the Queues HTTP pull endpoint, not the Worker.** | Cloudflare Queues pull API |

No unauthenticated route exists except the sign-in redirect and OIDC callback.

---

## Browser / UI routes

### Auth
| Method | Path | Purpose |
| :--- | :--- | :--- |
| GET | `/auth/login` | Redirect to Entra authorize endpoint (PKCE challenge + state stored server-side). |
| GET | `/auth/callback` | Exchange code, validate group claim, mint session. Rejects users outside the MSP security group. |
| POST | `/auth/logout` | Destroy session. |
| GET | `/api/me` | `{ upn, displayName, groupOk }` for the current session. |

### Tenants (Phase 1)
| Method | Path | Body / Notes |
| :--- | :--- | :--- |
| GET | `/api/tenants` | List tenants (metadata only — **never** secret plaintext). |
| POST | `/api/tenants` | `{ role, tenantId, clientId, clientSecret }`. Secret is AES-256-GCM encrypted in the Worker; only ciphertext + IV stored in D1. |
| POST | `/api/tenants/:id/test` | Acquires an app-only token and probes required scopes; returns per-scope pass/fail + missing consents. |
| POST | `/api/tenants/:id/secret` | Rotate secret (re-entry required; no reveal). |
| DELETE | `/api/tenants/:id` | Disconnect (typed-confirmation gated in UI). |

### Discovery & selection (Phase 2)
| Method | Path | Notes |
| :--- | :--- | :--- |
| GET | `/api/discovery/users?search=&cursor=` | Live source-tenant directory via Graph `User.Read.All` (Worker-side, paginated). |
| POST | `/api/migration-users` | Add selected users. Body: `MigrationUser[]` (partial). |
| POST | `/api/migration-users/import` | CSV upload. Returns line-level validation: `{ accepted, rejected: [{line, reason}] }`. |
| GET | `/api/migration-users` | List the migration queue. |
| DELETE | `/api/migration-users/:id` | Remove from queue. |

### Mapping & provisioning (Phase 3)
| Method | Path | Notes |
| :--- | :--- | :--- |
| PATCH | `/api/migration-users/:id/mapping` | `{ targetEmail?, targetUpn?, mappingStatus }`. Resolves/validates target on destination primary domain. |
| POST | `/api/provision` | `{ migrationUserIds }`. Worker provisions target users (`User.ReadWrite.All`), sets random temp password + force-change, triggers OneDrive pre-provisioning. |
| GET | `/api/passwords/download` | **One-time** CSV of temp credentials. Requires acknowledge flag. Purges plaintext from D1 after download; audit-logged. |

### Jobs / migration control (Phase 4)
| Method | Path | Notes |
| :--- | :--- | :--- |
| POST | `/api/jobs` | `{ migrationUserIds }`. Creates one job per user+selected-workload; enqueues one `JobDispatchMessage` each. |
| GET | `/api/jobs` | List jobs (Migration Monitor). |
| GET | `/api/jobs/:id` | Job detail. |
| POST | `/api/jobs/:id/cancel` | Cancel (modal-confirmed). |
| POST | `/api/jobs/:id/retry` | Re-dispatch a failed job. |
| POST | `/api/jobs/:id/delta` | Queue a delta pass (`pass: 'delta'`). |

### Reports / audit / budget / settings (Phase 4/5)
| Method | Path | Notes |
| :--- | :--- | :--- |
| GET | `/api/reports/:migrationUserId` | `PerUserReport`. |
| GET | `/api/reports/:migrationUserId/export` | CSV. |
| GET | `/api/audit?actor=&action=&from=&to=&cursor=` | Filterable `AuditEntry[]`. |
| GET | `/api/audit/export` | CSV (used before 90-day pruning). |
| GET | `/api/budget` | `FreeTierBudget` for the dashboard indicator. |
| GET | `/api/config` / PATCH `/api/config` | Engine config (concurrency, retention, poll floor). |

**Rate limiting (Worker-enforced):** per-session request cap on UI endpoints; the budget governor
(counters in D1) degrades gracefully — pauses non-essential writes and flips `EngineConfig.paused`
before any Cloudflare cap is hit.

---

## VM / engine routes — `/api/vm/*` (Access service token required)

| Method | Path | Request → Response | Notes |
| :--- | :--- | :--- | :--- |
| GET | `/api/vm/config` | → `EngineConfig` | Polled at start-up and periodically (respecting `minPollIntervalSec`). |
| POST | `/api/vm/token` | `VmTokenRequest` → `VmTokenResponse` | Worker runs the client-credentials flow using the decrypted client secret and returns a **short-lived** Graph token. The client secret never leaves the Worker. |
| GET | `/api/vm/jobs/:id` | → `Job` | Fetch current job state (for resume after reboot). |
| POST | `/api/vm/jobs/:id/status` | `StatusUpdate` → `{ ok }` | Explicit transition (e.g. `provisioning`→`running`, or a distinct failure state). |
| POST | `/api/vm/jobs/:id/progress` | `ProgressUpdate` → `{ ok }` | **≤ 1 write / job / 30 s.** Server rejects (429) over-frequent calls. |
| POST | `/api/vm/jobs/:id/checkpoint` | `CheckpointUpdate` → `{ ok }` | Durable resume point. |
| POST | `/api/vm/jobs/:id/items` | `ItemLogBatch` → `{ inserted }` | Batched item-level skip/fail records. |

### Engine polling / write discipline (free-tier critical)
- **Never** poll faster than `minPollIntervalSec` (default 30 s). The Worker enforces a server-side
  floor and returns `429 Retry-After` if violated.
- Batch progress: at most one `progress` write per job per 30 s — report cumulative counts, not
  per-item.
- Item logs are batched (flush on size or interval), never one HTTP call per item.
- Job dispatch is the **only** thing that flows through Queues. Everything else is D1 via these
  endpoints.

### Graph usage constraints the engine must honour
- **EWS is forbidden.** Exchange uses Graph `exportItems` / `createImportSession` (v1.0), max
  **20 items per export call**; delta via `mailboxFolder: delta` + `mailboxItem: delta`.
- OneDrive uses the delta API for incremental passes; upload sessions for files > 4 MB; path/char
  remediation logged per item.
- Honour `Retry-After` on **every** 429/503 without exception; exponential backoff + jitter;
  per-mailbox and per-tenant concurrency caps; a governor that self-reduces concurrency before
  sustained throttling.

---

## Standard error envelope

```json
{ "error": { "code": "string_code", "message": "human readable", "detail": "optional" } }
```

Common `code`s: `unauthorized`, `forbidden`, `csrf`, `rate_limited`, `budget_exhausted`,
`not_found`, `validation`, `graph_error`, `token_error`.
