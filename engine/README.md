# EntraShift — Migration Engine (Azure VM compute plane)

Persistent Python service that performs the heavy lifting of an EntraShift
tenant-to-tenant migration: it pulls one user+workload job at a time, exports
from the source tenant and imports into the destination tenant over Microsoft
Graph, and reports all state back to the Cloudflare Worker control plane.

---

## Where it sits

```
( Cloudflare Worker: /api/vm/* )      [ Cloudflare Queues ]
        ^   |  short-lived Graph            |  job dispatch (HTTP pull,
        |   |  tokens, D1 state             |  scoped API token)
 Access |   v                               v
 service   +------------------ this engine ------------------+
 token     |  worker loop -> exchange/onedrive migrators     |
           +---------------------+---------------------------+
        Graph export |                     | Graph import
                     v                     v
             [ Source tenant ]     [ Destination tenant ]
```

Read the authoritative contracts before changing anything here:
- [`../shared/contracts.ts`](../shared/contracts.ts) — wire types (mirrored in
  [`entrashift_engine/contracts.py`](./entrashift_engine/contracts.py)).
- [`../shared/api-spec.md`](../shared/api-spec.md) — the `/api/vm/*` HTTP contract.

## Security model (must not be weakened)

- **No long-lived tenant secrets on the VM, ever.** Tenant client secrets live
  only in the Worker (AES-256-GCM envelope-encrypted in D1). The engine calls
  `POST /api/vm/token` and receives only **short-lived Graph access tokens**,
  held in memory and never persisted or logged.
- **The engine's own two credentials** — a Cloudflare Access *service token*
  and a queue-consume-scoped Cloudflare API token — come from **Azure Key Vault
  via managed identity** in production (`SECRETS_PROVIDER=keyvault`). The `env`
  provider is a **dev-only** fallback.
- **Least privilege.** All Graph access uses the source/destination App
  Registrations' **application permissions** with admin consent (see SoW §1).
  No global admin credentials.
- **Logs never contain credentials or message content.** The JSON-lines logger
  redacts known-sensitive keys and bearer tokens as a backstop; call sites must
  not pass secrets or item bodies in the first place.

## Free-tier discipline (hard constraint — SoW §1.1)

- **Queues carry job dispatch only.** All progress/state flows through D1 via
  `/api/vm/*`. The engine never writes back through Queues.
- **Never poll faster than 30 s.** `poll_interval_floor_sec` (client) and the
  Worker's server-side floor both enforce this.
- **≤ 1 progress write per job per 30 s.** Progress is batched and cumulative;
  `ControlPlaneClient.update_progress` suppresses over-frequent writes.
- **Item logs are batched**, never one HTTP call per item.

## Graph specifics

- **Exchange (EWS is forbidden).** `exportItems` (max **20 items/call**) +
  `createImportSession` upload; folder/item **delta** for incremental passes;
  primary + archive + shared mailboxes.
- **OneDrive.** `/drive/root/delta` enumeration; upload sessions for files
  > 4 MB (320 KiB-aligned chunks); invalid-char / path-length remediation logged
  per item; latest version only (no version history).
- **Throttling.** `Retry-After` is honoured on **every** 429/503; exponential
  backoff + full jitter otherwise; per-tenant + per-mailbox concurrency caps; an
  adaptive governor self-reduces concurrency before sustained throttling.

## Layout

```
engine/
├─ entrashift_engine/
│  ├─ contracts.py        # wire types (mirror of shared/contracts.ts)
│  ├─ config.py           # static settings (env / .env)
│  ├─ secrets.py          # Key Vault (managed identity) + env fallback
│  ├─ logging_setup.py    # JSON-lines rotating logs, credential redaction
│  ├─ control_plane.py    # client for /api/vm/* (CF Access headers, 30s floor)
│  ├─ queue_consumer.py   # Cloudflare Queues HTTP pull + ack/retry
│  ├─ checkpoint.py       # opaque resume state (survives reboot)
│  ├─ job_context.py      # per-job deps + batched progress/item writes
│  ├─ graph/
│  │  ├─ client.py        # token-injecting HTTP client, Retry-After, typed errors
│  │  ├─ throttle.py      # concurrency semaphores + adaptive governor
│  │  └─ errors.py        # AuthExpired/PermissionRevoked/QuotaExceeded/...
│  ├─ exchange/
│  │  ├─ exporter.py      # exportItems (20/batch)
│  │  ├─ importer.py      # createImportSession + upload
│  │  └─ migrator.py      # folder/item delta orchestration, skip-and-log
│  ├─ onedrive/
│  │  └─ migrator.py      # delta copy, upload sessions, remediation
│  ├─ worker.py           # main async loop + graceful shutdown
│  └─ __main__.py         # entrypoint (entrashift-engine)
└─ tests/                 # contracts parity, throttle, checkpoint
```

## Run (development)

> Do **not** run installs or dev servers as part of automated setup — the
> commands below are for a human operator on a dev box or the VM.

```bash
cd engine
python -m venv .venv && . .venv/bin/activate      # (Windows: .venv\Scripts\activate)
pip install -e '.[dev]'          # add ',azure' on the VM for Key Vault support
cp .env.example .env             # fill in dev values; NEVER commit .env

# lint / type-check / test
ruff check .
mypy entrashift_engine
pytest

# run the engine
entrashift-engine                # or: python -m entrashift_engine
```

## Run (Azure VM, production-shaped)

1. Provision the VM with a **system-assigned managed identity** and grant it
   `get` on the Key Vault secrets `cf-access-client-id`,
   `cf-access-client-secret`, `cf-queue-api-token`.
2. Install with the Azure extra: `pip install -e '.[azure]'`.
3. Set `ENTRASHIFT_SECRETS_PROVIDER=keyvault` and `ENTRASHIFT_KEY_VAULT_URL=...`
   (plus the control-plane / queue ids) via the environment or a systemd unit —
   **no secrets on disk**.
4. Run under a supervisor (systemd) that delivers **SIGTERM** on stop; the
   engine drains the in-flight job to a checkpoint and exits cleanly. On reboot
   it resumes from the last checkpoint.

## Deployment gate

Deploying this engine against a real tenant requires the IT/security review
gate in [`../scopeofwork.md`](../scopeofwork.md) §5 to have passed. Flag an
IT/security review before connecting to production.
