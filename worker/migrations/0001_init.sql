-- EntraShift D1 schema — control-plane source of truth.
-- Job state, mappings, secret ciphertext, audit log, and the free-tier budget governor.
-- Apply with:  wrangler d1 migrations apply entrashift
--
-- Design constraints (SoW §1.1): D1 free tier = 5M reads/day, 100k writes/day, 5GB.
-- Progress is batched (≤1 write / job / 30s). Audit log is pruned/exported on a 90-day window.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Server-side sessions (Entra ID SSO). No secrets here — session id is the cookie.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,           -- opaque random session id (the cookie value, hashed)
  actor_upn     TEXT NOT NULL,
  actor_oid     TEXT NOT NULL,              -- Entra object id
  display_name  TEXT,
  group_ok      INTEGER NOT NULL DEFAULT 0, -- 1 = member of MSP security group
  csrf_token    TEXT NOT NULL,
  created_at    TEXT NOT NULL,              -- ISO-8601 UTC
  expires_at    TEXT NOT NULL               -- ≤ 8h from creation
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- Transient OIDC login flow state (PKCE verifier + nonce), short-lived, cleaned on callback.
CREATE TABLE IF NOT EXISTS auth_flow (
  state          TEXT PRIMARY KEY,
  code_verifier  TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  redirect_to    TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Tenants. Secret is AES-256-GCM ciphertext under the master Worker Secret.
-- Plaintext is NEVER stored. UI shows metadata only (masked id + expiry).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id                TEXT PRIMARY KEY,
  role              TEXT NOT NULL CHECK (role IN ('source','destination')),
  tenant_id         TEXT NOT NULL,          -- Entra tenant GUID
  client_id         TEXT NOT NULL,          -- App Registration (client) id
  secret_ciphertext TEXT NOT NULL,          -- base64 AES-256-GCM ciphertext (incl. auth tag)
  secret_iv         TEXT NOT NULL,          -- base64 12-byte IV / nonce
  secret_expiry     TEXT,                   -- ISO-8601 UTC, displayed in UI
  display_name      TEXT,
  status            TEXT NOT NULL DEFAULT 'disconnected'
                      CHECK (status IN ('disconnected','connected','error')),
  last_tested_at    TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (role)                             -- one source + one destination per deployment (v1)
);

-- ---------------------------------------------------------------------------
-- Migration users — the selected/imported queue, mapping, and workload flags.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS migration_users (
  id                 TEXT PRIMARY KEY,
  source_email       TEXT NOT NULL,
  target_email       TEXT,
  target_upn         TEXT,                  -- resolved on destination primary domain
  migrate_exchange   INTEGER NOT NULL DEFAULT 0,
  migrate_onedrive   INTEGER NOT NULL DEFAULT 0,
  auto_create_target INTEGER NOT NULL DEFAULT 0,
  include_archive    INTEGER NOT NULL DEFAULT 0,
  mapping_status     TEXT NOT NULL DEFAULT 'unmapped'
                       CHECK (mapping_status IN
                         ('unmapped','mapped','auto_create','provisioned','invalid')),
  created_at         TEXT NOT NULL,
  UNIQUE (source_email)
);

-- ---------------------------------------------------------------------------
-- Jobs — one row per (migration_user, workload). D1 is source of truth for state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  migration_user_id TEXT NOT NULL REFERENCES migration_users(id) ON DELETE CASCADE,
  workload          TEXT NOT NULL CHECK (workload IN ('exchange','onedrive')),
  status            TEXT NOT NULL DEFAULT 'queued',
  phase_text        TEXT,
  progress_current  INTEGER NOT NULL DEFAULT 0,
  progress_total    INTEGER,
  bytes_done        INTEGER NOT NULL DEFAULT 0,
  bytes_total       INTEGER,
  delta_token       TEXT,                   -- opaque Graph delta token for next incremental pass
  checkpoint        TEXT,                   -- JSON resume state (survives VM reboot)
  attempts          INTEGER NOT NULL DEFAULT 0,
  dispatch_seq      INTEGER NOT NULL DEFAULT 0,
  delta_passes      INTEGER NOT NULL DEFAULT 0,
  last_progress_at  TEXT,                   -- server-side floor enforcement (≤1 write/30s)
  error_class       TEXT,
  error_detail      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT,
  UNIQUE (migration_user_id, workload)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

-- Item-level skip-and-log. A failed item never fails the whole mailbox job.
CREATE TABLE IF NOT EXISTS job_items (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL,
  folder_path  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('skipped','failed')),
  error_class  TEXT NOT NULL,
  error_detail TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items (job_id);

-- ---------------------------------------------------------------------------
-- Temporary provisioning credentials. Envelope-encrypted; purged after one-time
-- CSV download. Every account is force-change-at-next-sign-in.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provisioned_credentials (
  id                  TEXT PRIMARY KEY,
  migration_user_id   TEXT NOT NULL REFERENCES migration_users(id) ON DELETE CASCADE,
  target_upn          TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL,        -- AES-256-GCM under master key
  password_iv         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  downloaded_at       TEXT                  -- set on download; ciphertext nulled at purge
);

-- ---------------------------------------------------------------------------
-- Audit log — every administrative action. Rolling 90-day retention.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  actor_upn  TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL                  -- ISO-8601 UTC
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_upn);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);

-- ---------------------------------------------------------------------------
-- Free-tier budget governor. One row per UTC day; counters incremented as usage
-- accrues. When a counter crosses its soft threshold, `degraded` flips and the
-- engine config reports paused=true.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_counters (
  day             TEXT PRIMARY KEY,         -- YYYY-MM-DD (UTC)
  workers_requests INTEGER NOT NULL DEFAULT 0,
  d1_writes       INTEGER NOT NULL DEFAULT 0,
  queue_ops       INTEGER NOT NULL DEFAULT 0,
  degraded        INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Engine + app configuration (concurrency caps, poll floor, retention).
-- Seeded with conservative defaults; editable in Settings.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO config (key, value) VALUES
  ('minPollIntervalSec', '30'),
  ('perMailboxConcurrency', '2'),
  ('perTenantConcurrency', '4'),
  ('exchangeExportBatchSize', '20'),
  ('onedriveUploadSessionThresholdBytes', '4194304'),
  ('itemMaxRetries', '5'),
  ('auditRetentionDays', '90'),
  -- soft thresholds (fraction of the Cloudflare free-tier cap at which we degrade)
  ('budgetSoftFraction', '0.85'),
  ('workersDailyLimit', '100000'),
  ('d1WritesDailyLimit', '100000'),
  ('queueOpsDailyLimit', '10000');
