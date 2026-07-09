# EntraShift — Security Model & Secret Handling

Concise threat model, secret-handling summary, and the prototype/gate posture for EntraShift. Read
alongside [scopeofwork.md](../scopeofwork.md) (Phase 0 in particular), [app-registrations.md](./app-registrations.md),
and [deployment.md](./deployment.md).


---

## 1. Assets we protect

| Asset                                             | Sensitivity           | Where it lives                                                                                 |
| :--------------------------------------------------| :----------------------| :-----------------------------------------------------------------------------------------------|
| Master encryption key                             | Critical              | Cloudflare **Worker Secret** only (`MASTER_ENCRYPTION_KEY`)                                    |
| Tenant client secrets (source + dest app regs)    | Critical              | AES-256-GCM **ciphertext + IV** in D1 (`tenants`); plaintext only transiently in Worker memory |
| Temporary provisioning passwords                  | Critical, short-lived | Envelope-encrypted in D1 (`provisioned_credentials`); purged after one-time CSV download       |
| Short-lived Graph access tokens                   | High, minutes-lived   | Worker memory + VM memory in transit; never persisted                                          |
| OIDC client secret (UI app)                       | High                  | Worker Secret (`OIDC_CLIENT_SECRET`)                                                           |
| Cloudflare Access service token + Queue API token | High                  | **Azure Key Vault**, read by VM managed identity                                               |
| Session cookies                                   | High                  | Browser (HttpOnly/Secure/SameSite=Strict); session row in D1                                   |
| Migration content (mail, files)                   | High (customer data)  | In transit through the VM only; not stored at rest by EntraShift                               |
| Audit log                                         | Medium                | D1 (`audit_log`), 90-day retention                                                             |

---

## 2. Trust boundaries

```
[ Browser ]  --Entra SSO session (cookie)-->  [ Cloudflare Worker ]  <--D1--  state/secrets(ciphertext)
                                                     |  Worker Secret: master key, OIDC secret
                                                     |  Queue producer (dispatch only)
        Access service-token JWT (Cf-Access-Jwt-Assertion)
                                                     v
                                            [ Azure VM engine ]  <--Key Vault (managed identity)-- CF tokens
                                                     |  short-lived Graph tokens from Worker (POST /api/vm/token)
                             Graph export <----------+----------> Graph import
                          [ Source tenant ]                    [ Destination tenant ]
```

Two authentication planes (api-spec):

- **Engineer browser → `/api/*`, `/auth/*`:** Entra ID SSO (OIDC Auth-Code + PKCE) → server-side
  session cookie; CSRF token on every state-changing route.
- **Azure VM → `/api/vm/*` only:** Cloudflare Access **service token**; the Worker validates the
  `Cf-Access-Jwt-Assertion` (correct `aud` + team domain) on every request.
- **VM → Cloudflare Queues:** scoped **consume-only** API token, direct to the Queues HTTP pull API
  (not through the Worker).

No unauthenticated route exists except the sign-in redirect and OIDC callback.

---

## 3. Envelope encryption (the core secret-handling design)

Neither store alone is sufficient: D1 is not a secrets store, and Worker Secrets cannot hold values
a user types into the UI at runtime. The **envelope pattern** combines them (SoW Phase 0):

1. A single **master key** (base64 32-byte AES-256) is generated at deployment
   ([`New-MasterKey`](./scripts/) scripts) and set as the Worker Secret `MASTER_ENCRYPTION_KEY`. It
   is never in source, never readable from the dashboard, never returned by any API.
2. When an engineer enters a tenant client secret in the UI, the **Worker** encrypts it with
   **AES-256-GCM** (12-byte random IV per secret; GCM auth tag included) under the master key.
3. Only the **ciphertext + IV** are written to D1 (`tenants.secret_ciphertext`, `secret_iv`).
   Plaintext exists only transiently in Worker memory during token acquisition.
4. The UI shows **metadata only** — a masked identifier and the secret expiry date. There is **no
   reveal function**; rotation requires re-entry.

**Consequence:** a D1 compromise yields only ciphertext. Decryption additionally requires the master
key, which lives only in the Worker Secret store. The engine never receives a tenant secret — it
gets only **short-lived Graph access tokens** minted by the Worker (`POST /api/vm/token`), which run
the client-credentials flow server-side and never leak the secret past the Worker boundary.

The same envelope scheme protects temporary provisioning passwords (`provisioned_credentials`).

---

## 4. Temporary-password one-time-CSV caveat (accepted interim risk)

Auto-provisioned destination users get a random temporary password with **force-change-at-next-
sign-in** (SoW Phase 3). Delivery is a **one-time CSV download** to the engineer. Accepted handling,
with its residual risk stated plainly:

- Passwords are held **envelope-encrypted** in D1 only until the CSV is downloaded, then the
  plaintext ciphertext is **purged** (`password_ciphertext` nulled, `downloaded_at` set).
- The download is **audit-logged** (`password_csv_download`).
- Every account is created **force-change-at-next-sign-in**, so the exposure window is a single first
  sign-in.
- The UI download modal states the file contains credentials and is a one-time download, gated by an
  acknowledge checkbox (branding §7.4).

**Residual risk:** the CSV itself is plaintext credentials on the engineer's machine once
downloaded — EntraShift cannot protect it after that point. Engineers must handle and delete it per
the organisation's credential-handling policy. This is an **interim** approach; a follow-up (e.g.
per-user secure hand-off, or push to a password manager) should be evaluated at the security review.

---

## 5. Key threats & mitigations

| Threat | Mitigation |
| :--- | :--- |
| D1 database exfiltration | Secrets stored only as AES-256-GCM ciphertext; master key not in D1. |
| Master key disclosure | Held only as a Worker Secret; never logged, never in source, never returned by API. Rotation = re-encrypt all ciphertext (see §7). |
| Stolen browser session | HttpOnly/Secure/SameSite=Strict cookies; ≤ 8 h expiry; server-side session store; CSRF tokens on state-changing routes. |
| Unauthorised UI access | Entra SSO restricted to the MSP security group, enforced at both Entra (assignment required) and the Worker (group-claim check). |
| Forged VM requests | `/api/vm/*` requires a valid Cloudflare Access service-token JWT (`aud` + team domain verified); browser routes reject service tokens and vice-versa. |
| Over-privileged Graph access | Least-privilege application permissions (SoW §1); `Directory.ReadWrite.All` excluded; mailbox scoping via ApplicationAccessPolicy / RBAC for Applications. |
| Long-lived secret on the VM | VM never holds a tenant secret — only short-lived Graph tokens from the Worker; CF/Queue tokens live in Key Vault (managed identity), not on disk. |
| Free-tier exhaustion / DoS-by-usage | Server-enforced 30 s poll floor; ≤ 1 progress write/job/30 s; Queues carry dispatch only; budget governor degrades gracefully before any Cloudflare cap. |
| Credential leakage via logs | Audit log and engine logs contain no credentials or message content (SoW §5); secrets never logged. |
| Secret sprawl on rotation | Each credential independently revocable; rotation procedures documented in [deployment.md](./deployment.md#credential-rotation). |
| EWS deprecation dependency | EWS is **forbidden**; Exchange uses Graph `exportItems`/`createImportSession` (v1.0) + delta. |

---

## 6. Data handling & retention

- **Migration content** (mail/files) flows through the VM in transit only; EntraShift does not store
  message content or file bytes at rest. Item-level errors log item id/folder/error class — **not**
  content.
- **Audit log** (D1): every administrative action with actor UPN, UTC timestamp, action, target;
  read-only viewer; **90-day** rolling retention with CSV export before pruning (D1 free-tier
  storage constraint).
- **Engine logs** (VM): structured JSON-lines, rotating, no credentials or content.

---

## 7. Master-key rotation (handle with care)

The master key is a single point of decryptability. Rotating it is **not** a drop-in secret swap:

1. Generate a new key (`New-MasterKey`).
2. Decrypt every ciphertext in D1 (`tenants`, any live `provisioned_credentials`) under the **old**
   key and re-encrypt under the **new** key — in practice, re-enter tenant secrets via the UI after
   the swap, since the old plaintext is not otherwise recoverable.
3. `wrangler secret put MASTER_ENCRYPTION_KEY` with the new value.
4. Verify Tenant Connections test passes for both tenants.

If the master key is **lost**, all stored tenant secrets are unrecoverable and must be re-entered.
Never rotate without a re-encryption plan, and never keep the old key after rotation completes.