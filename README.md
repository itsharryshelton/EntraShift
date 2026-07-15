# EntraShift

Custom **Tenant-to-Tenant (M365 → M365) migration tool**. Securely connects a source and
destination Microsoft 365 tenant, discovers/maps users, and migrates Exchange Online and
OneDrive for Business workloads.
<img width="2560" height="1279" alt="msedge_1P369MtfSw" src="https://github.com/user-attachments/assets/48768af6-15bb-4dd7-8e3d-d8da11756d18" />

---

## Architecture

The control plane (light, edge) is decoupled from the migration engine (heavy, persistent) to
avoid serverless timeout/CPU limits and to keep all Cloudflare usage inside the **Free Tier**.

```
[ Engineer Browser ] --Entra ID SSO (MSP tenant)--> ( Cloudflare Worker: UI/API )
                                                          |            |
                                                    [ D1: state,   [ Queues:
                                                      mappings,      job dispatch ]
                                                      audit log ]        |
                                                          ^              | (HTTP pull,
                                     (progress/checkpoints,|             |  scoped API token)
                                      Access service token)              v
[ Source Tenant ] <== Graph export ==  [ Azure VM Engine ]  == Graph import ==> [ Dest Tenant ]
                                        (creds: Azure Key Vault)
```

| Layer | Tech | Directory | Responsibility |
| :--- | :--- | :--- | :--- |
| **Control plane / Worker** | TypeScript · Hono · Cloudflare Workers | [`worker/`](./worker) | Web UI/API, Entra SSO, secret envelope encryption, D1 state, Queue dispatch, VM auth, free-tier budget governor |
| **Web UI** | React · Vite · TypeScript | [`web/`](./web) | The 9 admin console screens; design system; built to static assets served by the Worker |
| **Migration engine / Compute** | Python · Microsoft Graph | [`engine/`](./engine) | Persistent worker service on an Azure VM: pulls jobs, exports/imports mail + files, throttling/backoff, checkpointing |
| **Shared contract** | TypeScript + Markdown | [`shared/`](./shared) | Job/status/workload enums and the Worker↔Engine API contract both sides implement |
| **Database** | SQL (D1) | [`worker/migrations/`](./worker/migrations) | D1 schema migrations (job state, mappings, audit log, budget counters) |
| **Docs & scripts** | Markdown · PowerShell | [`docs/`](./docs) | App Registration setup, deployment, RBAC scoping |

### Why the split matters (`compute` vs `worker`)

- **The Worker never does heavy lifting.** No mailbox/file bytes flow through it. It holds state,
  dispatches one small queue message per user+workload, and hands the VM short-lived Graph tokens.
- **The Engine never holds long-lived secrets.** Tenant client secrets live only in the Worker
  (envelope-encrypted in D1, decrypted transiently in memory). The Engine requests short-lived
  Graph access tokens from the Worker over an authenticated channel.
- **All progress flows through D1, never back through Queues** — Queues carries dispatch only, to
  stay inside the 10k-ops/day free-tier budget.

See [`shared/api-spec.md`](./shared/api-spec.md) for the exact contract and
[`scopeofwork.md`](./scopeofwork.md) / [`branding-guidelines.md`](./branding-guidelines.md) for
the full requirements and design system.

## Repository layout

```
.
├─ worker/          # Cloudflare Worker control plane (TypeScript)
│  ├─ src/          #   auth, crypto, db, routes, middleware, queue
│  └─ migrations/   #   D1 SQL schema
├─ web/             # React + Vite SPA (design system + 9 screens)
├─ engine/          # Python migration engine (Azure VM)
├─ shared/          # Worker↔Engine contract (TS types + API spec)
├─ docs/            # App Reg setup, deployment, RBAC scoping
├─ scopeofwork.md
└─ branding-guidelines.md
```

## Getting started

Each app has its own README with setup and run instructions:

- [`worker/README.md`](./worker/README.md) — deploy the control plane, bind D1/Queues, set secrets
- [`web/README.md`](./web/README.md) — build the UI
- [`engine/README.md`](./engine/README.md) — run the migration engine on the Azure VM
- [`docs/deployment.md`](./docs/deployment.md) — end-to-end deployment + the security review gate

<img width="2560" height="1279" alt="msedge_Ubw5Dc9Grn" src="https://github.com/user-attachments/assets/dbdc609b-c3c3-48c0-a401-e2f6209d244b" />


## Security posture (summary)

- No global admin credentials, ever. Access is via multi-tenant Entra ID **App Registrations with
  application permissions + admin consent**, scoped least-privilege (see SoW §1).
- Tenant client secrets are **AES-256-GCM envelope-encrypted** under a master key held only as a
  Cloudflare Worker Secret; only ciphertext is stored in D1; secrets are never returned to the
  browser and never logged.
- Web UI gated by Entra ID SSO (OIDC Authorization Code + PKCE), restricted to an MSP security
  group; server-side HttpOnly/Secure/SameSite=Strict sessions.
- EWS is **not used** (disabled by Microsoft from Oct 2026) — Exchange runs on the Graph mailbox
  import/export APIs.
