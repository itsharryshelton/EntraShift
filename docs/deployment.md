# EntraShift — Deployment Guide

End-to-end deployment of the EntraShift control plane (Cloudflare Worker + D1 + Queues), the Web
UI, and the Azure VM migration engine. Follow the sections in order.

## Contents

0. [Prerequisites](#0-prerequisites)
1. [App registrations](#1-app-registrations)
2. [Cloudflare: D1 database + migrations](#2-cloudflare-d1-database--migrations)
3. [Cloudflare: Queue (job dispatch only)](#3-cloudflare-queue-job-dispatch-only)
4. [Cloudflare: Worker Secrets](#4-cloudflare-worker-secrets)
5. [Cloudflare Access: service token + application (aud)](#5-cloudflare-access-service-token--application-aud)
6. [Build the Web UI + deploy the Worker](#6-build-the-web-ui--deploy-the-worker)
7. [Azure VM: provision + install the engine as a systemd service](#7-azure-vm-provision--install-the-engine-as-a-systemd-service)
8. [Azure Key Vault: store VM credentials + managed identity](#8-azure-key-vault-store-vm-credentials--managed-identity)
9. [Free-tier guardrails](#free-tier-guardrails)
10. [Credential rotation](#credential-rotation)

---

## 0. Prerequisites

| Tool | Use |
| :--- | :--- |
| Node.js 20+ and npm | Build the Web UI, run `wrangler` |
| `wrangler` (Cloudflare CLI) | Deploy Worker, D1, Queues, Secrets |
| A Cloudflare account (Free plan) with **Zero Trust** enabled (free tier, ≤ 50 seats) | Worker hosting + Access |
| PowerShell 7+ with `Microsoft.Graph` module | App-registration scripts |
| `openssl` (or PowerShell) | Master-key generation |
| Azure subscription + `az` CLI | The migration-engine VM + Key Vault |
| Two Microsoft 365 **test** tenants | Source + destination (do **not** use production before the gates) |

Clone the repo. All commands below use paths relative to the repo root unless noted.

---

## 1. App registrations

Create the three app registrations **first** — the Worker vars and secrets reference them. Follow
[app-registrations.md](./app-registrations.md):

1. **MSP-tenant UI SSO app** → gives you `OIDC_CLIENT_ID`, `ENTRA_TENANT_ID`, `ALLOWED_GROUP_ID`,
   and the `OIDC_CLIENT_SECRET` you will set in §4.
2. **Source migration app** and **destination migration app** → their tenant/client IDs + secrets
   are entered later in the UI (Tenant Connections), **not** in `wrangler.jsonc`.

---

## 2. Cloudflare: D1 database + migrations

Create the D1 database and capture its id:

```bash
cd worker
wrangler d1 create entrashift
```

`wrangler d1 create` prints a `database_id`. Paste it into
[`worker/wrangler.jsonc`](../worker/wrangler.jsonc), replacing `REPLACE_WITH_D1_DATABASE_ID`:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "entrashift",
    "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "migrations_dir": "migrations" }
]
```

Apply the schema migration ([`migrations/0001_init.sql`](../worker/migrations/0001_init.sql)):

```bash
# Local (Miniflare) for dev:
wrangler d1 migrations apply entrashift --local
# Remote (the real D1 database):
wrangler d1 migrations apply entrashift --remote
```

The migration seeds the `config` table with the conservative engine defaults (poll floor 30 s,
concurrency caps, batch sizes, free-tier limits). Verify:

```bash
wrangler d1 execute entrashift --remote --command "SELECT key, value FROM config ORDER BY key;"
```

---

## 3. Cloudflare: Queue (job dispatch only)

Queues carries **only** job-dispatch messages — one small `JobDispatchMessage` per user+workload.
All progress/state flows through D1 (SoW §1.1; free-tier budget: 10,000 queue ops/day).

```bash
wrangler queues create entrashift-jobs
```

The producer binding (`JOB_QUEUE` → `entrashift-jobs`) is already declared in `wrangler.jsonc`. The
VM **does not** use a Worker consumer binding — it pulls via the Queues **HTTP pull API** with a
scoped API token (§8), so no per-message Worker invocation is spent.

Create the queue-consume API token (Cloudflare dashboard → **My Profile → API Tokens → Create
Token**, or via API): scope it to **Queues → Edit/Consume** for this account only, nothing else.
Store the token in Azure Key Vault (§8) — it never goes into the Worker or the repo.

---

## 4. Cloudflare: Worker Secrets

Secrets are set with `wrangler secret put` and are **never** written to `wrangler.jsonc`, source, or
the browser (SoW Phase 0).

### 4.1 Generate the master encryption key

The envelope master key is a base64 32-byte (256-bit) AES-256 key. Generate it and set it in one
step so the plaintext never lands on disk or in shell history:

```bash
# bash / Git Bash — using openssl rand base64 32 (32 bytes = 256 bits):
openssl rand -base64 32 | tr -d '\n' | wrangler secret put MASTER_ENCRYPTION_KEY

# or via the provided script:
./docs/scripts/New-MasterKey.sh | tr -d '\n' | wrangler secret put MASTER_ENCRYPTION_KEY
```

```powershell
# PowerShell — uses a CSPRNG, not Get-Random:
cd worker
../docs/scripts/New-MasterKey.ps1 -SetSecret       # generates + pipes into wrangler
# or print-then-set:
../docs/scripts/New-MasterKey.ps1 | wrangler secret put MASTER_ENCRYPTION_KEY
```

> There is exactly **one** master key per deployment. If it is lost, every stored tenant secret
> becomes undecryptable and must be re-entered; rotating it requires re-encrypting all D1 ciphertext
> (re-enter tenant secrets via the UI). See [security.md](./security.md).

### 4.2 Set the OIDC client secret

From the MSP-tenant UI SSO app (§1):

```bash
wrangler secret put OIDC_CLIENT_SECRET
# paste the UI app-registration client secret when prompted
```

### 4.3 Fill in the non-secret vars

Edit the `vars` block in `wrangler.jsonc` with real values:

| Var | Value |
| :--- | :--- |
| `ENTRA_TENANT_ID` | MSP tenant GUID |
| `OIDC_CLIENT_ID` | UI SSO app client id |
| `OIDC_REDIRECT_URI` | `https://<your-worker-host>/auth/callback` (must match the app reg) |
| `ALLOWED_GROUP_ID` | MSP security group object id |
| `SESSION_TTL_SECONDS` | `28800` (8 h max) |
| `MIN_POLL_INTERVAL_SEC` | `30` |
| `CF_ACCESS_TEAM_DOMAIN` | `https://<your-team>.cloudflareaccess.com` (from §5) |
| `CF_ACCESS_AUD` | the Access application **aud** tag (from §5) |

Confirm no secrets ended up in `wrangler.jsonc`:

```bash
wrangler secret list        # should show MASTER_ENCRYPTION_KEY, OIDC_CLIENT_SECRET
```

---

## 5. Cloudflare Access: service token + application (aud)

The VM authenticates to the Worker's `/api/vm/*` endpoints with a **Cloudflare Access service
token**; the Worker validates the `Cf-Access-Jwt-Assertion` header on every request against the
Access application's **aud** tag and your team domain (SoW Phase 0; api-spec auth model).

### 5.1 Create the service token

Cloudflare **Zero Trust → Access → Service Auth → Service Tokens → Create Service Token**:

- Name: `entrashift-vm`
- Copy the **Client ID** and **Client Secret** — shown once. These go into Azure Key Vault (§8), not
  the repo. The VM sends them as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers; Access
  mints the JWT the Worker validates.

### 5.2 Create the Access application (self-hosted) covering `/api/vm/*`

Zero Trust → **Access → Applications → Add an application → Self-hosted**:

- Application domain: your Worker host, path `/api/vm` (e.g. `entrashift.example.com/api/vm`).
- **Identity providers:** you may disable interactive IdPs for this app — it is machine-to-machine.
- **Policy:** action **Service Auth**, include **Service Token → `entrashift-vm`** (only). This makes
  the app reachable *only* with that service token.
- After saving, open the application → copy the **Application Audience (AUD) tag**.

Set the Worker vars accordingly:

- `CF_ACCESS_AUD` = the AUD tag above.
- `CF_ACCESS_TEAM_DOMAIN` = `https://<your-team>.cloudflareaccess.com`.

The Worker fetches the Access public keys from `<team-domain>/cdn-cgi/access/certs` and verifies the
JWT `aud` matches `CF_ACCESS_AUD`. Browser/UI routes (`/api/*`, `/auth/*`) remain gated by Entra SSO
sessions — only `/api/vm/*` uses the service token.

---

## 6. Build the Web UI + deploy the Worker

The Worker serves the built React SPA (`web/dist`) as static assets and handles `/api` + `/auth`
(see `wrangler.jsonc` `assets` binding).

```bash
# 1. Build the UI (produces web/dist):
cd web
npm ci
npm run build       # vite build

# 2. Deploy the Worker (from worker/):
cd ../worker
wrangler deploy
```

`wrangler deploy` uploads the Worker and the `web/dist` assets, binds D1 (`DB`), the queue producer
(`JOB_QUEUE`), and `ASSETS`. Smoke-test:

```bash
curl -i https://<your-worker-host>/auth/login     # → 302 redirect to Entra authorize
curl -i https://<your-worker-host>/api/me         # → 401 unauthorized when not signed in
```

Then sign in through the browser as an MSP-group member and confirm the dashboard loads with the
free-tier budget indicator.

> **Public URL / DNS is a security-review-gated step.** For test deployments keep the hostname
> private or behind Access. Do not attach a production/customer-facing hostname before the
> [Security Review Gate](#security-review-gate--blocking) passes — and flag DNS/public-endpoint
> changes to IT/security for sign-off.

---

## 7. Azure VM: provision + install the engine as a systemd service

The migration engine is a persistent Python service on an Azure VM in/near the destination
environment (SoW §1, §3). It pulls jobs from the Queue, requests short-lived Graph tokens from the
Worker, and reports progress/checkpoints to D1 via `/api/vm/*`.

### 7.1 Provision the VM (system-assigned managed identity enabled)

```bash
az group create --name entrashift-rg --location uksouth

az vm create \
  --resource-group entrashift-rg \
  --name entrashift-engine \
  --image Ubuntu2204 \
  --size Standard_D2s_v5 \
  --assign-identity \
  --admin-username azureuser \
  --generate-ssh-keys \
  --public-ip-address ""            # no public IP; reach it via bastion/private networking
```

`--assign-identity` enables the **system-assigned managed identity** used to read Key Vault (§8).
Keep the VM off the public internet (no public IP; use Azure Bastion or a private jump host). It
needs only **outbound** HTTPS to Cloudflare (Worker + Queues), Microsoft Graph, and Key Vault.

### 7.2 Install the engine

```bash
# On the VM:
sudo apt-get update && sudo apt-get install -y python3-venv
sudo useradd --system --home /opt/entrashift --shell /usr/sbin/nologin entrashift
sudo mkdir -p /opt/entrashift/engine /var/log/entrashift
sudo chown -R entrashift:entrashift /opt/entrashift /var/log/entrashift

# Copy the engine/ directory to /opt/entrashift/engine (scp/rsync via bastion), then:
sudo -u entrashift python3 -m venv /opt/entrashift/venv
sudo -u entrashift /opt/entrashift/venv/bin/pip install -r /opt/entrashift/engine/requirements.txt
```

The engine reads its runtime config from `GET /api/vm/config` (poll floor, concurrency caps, batch
sizes) — do not hardcode those. It reads credentials from Key Vault via managed identity at startup
(§8): the Cloudflare Access service token (client id + secret) and the Queue-consume API token. The
Worker host and the Access team domain are provided via environment (below).

### 7.3 systemd unit

Create `/etc/systemd/system/entrashift-engine.service`:

```ini
[Unit]
Description=EntraShift migration engine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=entrashift
Group=entrashift
WorkingDirectory=/opt/entrashift/engine
# Non-secret config only. All CREDENTIALS are fetched from Azure Key Vault via managed
# identity at startup — never place service tokens or API tokens in this file or in env.
Environment=ENTRASHIFT_WORKER_BASE=https://entrashift.example.com
Environment=ENTRASHIFT_KEYVAULT_URI=https://entrashift-kv.vault.azure.net/
Environment=ENTRASHIFT_QUEUE=entrashift-jobs
Environment=ENTRASHIFT_LOG_DIR=/var/log/entrashift
ExecStart=/opt/entrashift/venv/bin/python -m entrashift_engine
Restart=on-failure
RestartSec=10
# Hardening (prototype baseline — review before production):
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/log/entrashift

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now entrashift-engine
sudo systemctl status entrashift-engine
journalctl -u entrashift-engine -f          # engine also writes rotating JSON-lines logs to $ENTRASHIFT_LOG_DIR
```

> If the VM reboots, the engine resumes each job from its last D1 checkpoint
> (`GET /api/vm/jobs/:id` → `checkpoint`), per SoW Phase 4. No local job state is authoritative.

---

## 8. Azure Key Vault: store VM credentials + managed identity

The VM's credentials live in **Azure Key Vault**, read by the VM's managed identity — never on disk
in the engine (SoW Phase 0). Two independently-revocable secrets:

```bash
# Create the vault (RBAC authorization model).
az keyvault create --name entrashift-kv --resource-group entrashift-rg \
  --location uksouth --enable-rbac-authorization true

# Store the Cloudflare Access service token (from §5.1) and the Queue-consume API token (from §3).
az keyvault secret set --vault-name entrashift-kv --name cf-access-client-id     --value "<CF-Access-Client-Id>"
az keyvault secret set --vault-name entrashift-kv --name cf-access-client-secret --value "<CF-Access-Client-Secret>"
az keyvault secret set --vault-name entrashift-kv --name cf-queue-api-token      --value "<Queue-Consume-API-Token>"
```

Grant the VM's managed identity **read-only** access (least privilege — `Key Vault Secrets User`,
not an admin role):

```bash
VM_MI=$(az vm show -g entrashift-rg -n entrashift-engine --query identity.principalId -o tsv)
KV_ID=$(az keyvault show -g entrashift-rg -n entrashift-kv --query id -o tsv)
az role assignment create --assignee "$VM_MI" \
  --role "Key Vault Secrets User" --scope "$KV_ID"
```

The engine, at startup, uses `DefaultAzureCredential` (managed identity) to read those three secrets
from `ENTRASHIFT_KEYVAULT_URI`. Each secret is independently rotatable and revocable (see
[Credential rotation](#credential-rotation)).

> **Security posture recap:** the VM never holds a long-lived Graph/tenant secret. It obtains only
> **short-lived Graph access tokens** from the Worker (`POST /api/vm/token`); the tenant client
> secrets stay AES-256-GCM encrypted in the Worker/D1 and are decrypted only transiently in Worker
> memory (SoW Phase 0).

---

## Free-tier guardrails

These are hard design constraints (SoW §1.1), verified as part of the security gate:

- **Workers:** VM polls `/api/vm/*` no faster than `minPollIntervalSec` (30 s, server-enforced —
  the Worker returns `429 Retry-After` if violated). UI uses polling, no per-user websockets.
- **D1:** at most **one progress write per job per 30 s** (cumulative counts, not per item); item
  logs are batched; audit log pruned/exported on a rolling 90-day window.
- **Queues:** **job dispatch only** — one small message per user+workload; everything else via D1.
- **Budget governor:** `budget_counters` (D1) tracks daily Workers/D1/Queue usage; at the soft
  threshold (`budgetSoftFraction`, default 0.85 of each cap) it flips `degraded`, pauses
  non-essential writes, sets `EngineConfig.paused=true`, and alerts the engineer — before any
  Cloudflare cap is hit.

---

## Credential rotation

Each credential is independently revocable (SoW Phase 0). Rotation procedures:

| Credential | Rotate by |
| :--- | :--- |
| **Master encryption key** | Generate a new key, re-encrypt all D1 ciphertext under it (requires re-entering tenant secrets via the UI), then `wrangler secret put MASTER_ENCRYPTION_KEY`. Never rotate without a re-encryption plan — see [security.md](./security.md). |
| **OIDC client secret** | New secret on the UI app reg → `wrangler secret put OIDC_CLIENT_SECRET`. |
| **Tenant client secrets** | EntraShift UI → Tenant Connections → rotate (re-entry required; no reveal). Regenerate on the migration app reg with `New-EntraShiftAppRegistrations.ps1 -RotateSecret`. |
| **Cloudflare Access service token** | Recreate the service token in Zero Trust; update the two Key Vault secrets; restart the engine. |
| **Queue-consume API token** | Roll the Cloudflare API token; update the Key Vault secret; restart the engine. |

After any rotation, confirm the affected component still authenticates (UI sign-in, Tenant
Connections test, or `journalctl -u entrashift-engine`).
