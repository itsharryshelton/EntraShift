/**
 * EntraShift — Shared contract between the Cloudflare Worker (control plane) and the
 * Azure VM migration engine (compute).
 *
 * This file is the single source of truth for job/status/workload shapes and the
 * request/response bodies exchanged over the VM ↔ control-plane API. The Worker imports
 * these types directly; the Python engine mirrors them in `engine/entrashift_engine/contracts.py`
 * and the human-readable contract lives in `shared/api-spec.md`.
 *
 * Keep all three in sync. Any change here is a breaking change to the wire protocol.
 */

/* ------------------------------------------------------------------ *
 * Enums
 * ------------------------------------------------------------------ */

/** Which side of the migration a tenant sits on. */
export type TenantRole = 'source' | 'destination';

/** Migration workloads. v1 covers Exchange Online and OneDrive for Business only. */
export type Workload = 'exchange' | 'onedrive';
export const WORKLOADS: Workload[] = ['exchange', 'onedrive'];

/**
 * Job lifecycle status. A "job" is one user + one workload.
 *
 * Distinct terminal-failure states (auth_expired, permission_revoked, quota_exceeded)
 * surface in the UI with remediation hints (SoW Phase 4, Error Reporting).
 */
export type JobStatus =
  | 'queued' // dispatched to Queues, not yet claimed by the engine
  | 'provisioning' // target user / OneDrive site being created
  | 'running' // full pass in progress
  | 'backing_off' // engine self-throttling (Retry-After / governor)
  | 'delta_pending' // full pass done, awaiting a delta pass
  | 'delta_running' // incremental (delta) pass in progress
  | 'completed'
  | 'cancelled'
  | 'paused' // budget governor paused non-essential work
  // ---- distinct failure states (remediation hints in UI) ----
  | 'auth_expired'
  | 'permission_revoked'
  | 'quota_exceeded'
  | 'failed'; // generic unrecoverable failure

export const TERMINAL_STATUSES: JobStatus[] = [
  'completed',
  'cancelled',
  'auth_expired',
  'permission_revoked',
  'quota_exceeded',
  'failed',
];

/** Per-item outcome for the skip-and-log record (item-level failures never fail the job). */
export type ItemStatus = 'skipped' | 'failed';

/** Mapping state of a discovered/imported user before jobs are queued. */
export type MappingStatus =
  | 'unmapped' // no target chosen yet
  | 'mapped' // matched to an existing destination user
  | 'auto_create' // will be provisioned on run
  | 'provisioned' // target created
  | 'invalid'; // target unresolvable / validation failed

/* ------------------------------------------------------------------ *
 * Core records (also the D1 row shapes, camelCased at the API layer)
 * ------------------------------------------------------------------ */

export interface MigrationUser {
  id: string;
  sourceEmail: string;
  targetEmail: string | null;
  /** Resolved target UPN on the destination primary domain (never assumes shared domain). */
  targetUpn: string | null;
  migrateExchange: boolean;
  migrateOneDrive: boolean;
  autoCreateTarget: boolean;
  includeArchive: boolean;
  mappingStatus: MappingStatus;
  createdAt: string; // ISO-8601 UTC
}

export interface Job {
  id: string;
  migrationUserId: string;
  sourceEmail: string;
  targetUpn: string;
  workload: Workload;
  status: JobStatus;
  /** Human-facing phase line, e.g. "Migrating Inbox [1.2 GB / 4.5 GB]". */
  phaseText: string | null;
  progressCurrent: number; // items processed
  progressTotal: number | null; // total items (null = unknown/estimating)
  bytesDone: number;
  bytesTotal: number | null;
  /** Opaque Graph delta token for the next incremental pass. */
  deltaToken: string | null;
  /**
   * Opaque, engine-defined resume state (last folder/item cursor), persisted via
   * CheckpointUpdate. Returned by GET /api/vm/jobs/:id so the engine resumes from the last
   * checkpoint after a VM reboot instead of restarting from zero. Null before the first checkpoint.
   */
  checkpoint: Record<string, unknown> | null;
  attempts: number;
  errorClass: string | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobItem {
  id: string;
  jobId: string;
  itemId: string;
  folderPath: string | null;
  status: ItemStatus;
  errorClass: string;
  errorDetail: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Queue message (Worker → Queues → VM). ONE small message per user+workload.
 * Keep this tiny — Queue ops are metered per 64 KB and capped at 10k/day.
 * All state/progress flows through D1, never back through Queues.
 * ------------------------------------------------------------------ */

export interface JobDispatchMessage {
  jobId: string;
  migrationUserId: string;
  workload: Workload;
  sourceEmail: string;
  targetUpn: string;
  includeArchive: boolean;
  /** 'full' | 'delta' — the engine requests the delta token from the control plane. */
  pass: 'full' | 'delta';
  /** Monotonic dispatch counter for idempotency / stale-message detection. */
  dispatchSeq: number;
}

/* ------------------------------------------------------------------ *
 * VM ↔ Control-plane API bodies
 * (all VM endpoints authenticated via Cloudflare Access service-token JWT)
 * ------------------------------------------------------------------ */

/** POST /api/vm/token — engine asks the Worker for a short-lived Graph access token. */
export interface VmTokenRequest {
  tenantRole: TenantRole;
  /** Graph scope, always the app-only default `https://graph.microsoft.com/.default`. */
  scope?: string;
}
export interface VmTokenResponse {
  accessToken: string; // short-lived; never persisted by the engine
  expiresAt: string; // ISO-8601 UTC
  tenantId: string;
}

/**
 * POST /api/vm/jobs/:id/progress — batched progress update.
 * The engine MUST NOT call this more than once per job per 30 s (D1 write budget).
 */
export interface ProgressUpdate {
  status: JobStatus;
  phaseText?: string;
  progressCurrent?: number;
  progressTotal?: number | null;
  bytesDone?: number;
  bytesTotal?: number | null;
  /** Persist the delta token when a pass completes so incremental passes can resume. */
  deltaToken?: string | null;
}

/** POST /api/vm/jobs/:id/checkpoint — durable resume point (survives VM reboot). */
export interface CheckpointUpdate {
  /** Opaque, engine-defined resume state (last folder/item cursor). Stored as JSON in D1. */
  checkpoint: Record<string, unknown>;
  progressCurrent: number;
  bytesDone: number;
}

/** POST /api/vm/jobs/:id/status — explicit status transition with optional error detail. */
export interface StatusUpdate {
  status: JobStatus;
  errorClass?: string;
  errorDetail?: string;
}

/** POST /api/vm/jobs/:id/items — batched item-level skip/fail log. */
export interface ItemLogBatch {
  items: Array<{
    itemId: string;
    folderPath?: string;
    status: ItemStatus;
    errorClass: string;
    errorDetail: string;
  }>;
}

/** GET /api/vm/config — engine runtime configuration (from D1 `config`). */
export interface EngineConfig {
  /** Minimum seconds between status polls / progress writes (server-enforced floor). */
  minPollIntervalSec: number;
  /** Concurrency caps — conservative defaults, tunable in Settings. */
  perMailboxConcurrency: number;
  perTenantConcurrency: number;
  /** Exchange export batch cap (Graph hard limit is 20). */
  exchangeExportBatchSize: number;
  /** OneDrive large-file upload session threshold in bytes (Graph: >4 MB). */
  onedriveUploadSessionThresholdBytes: number;
  /** Item retry budget before skip-and-log. */
  itemMaxRetries: number;
  /** True when the budget governor has paused non-essential work — engine should idle. */
  paused: boolean;
}

/* ------------------------------------------------------------------ *
 * UI-facing summaries
 * ------------------------------------------------------------------ */

export interface FreeTierBudget {
  day: string; // YYYY-MM-DD (UTC)
  workers: { used: number; limit: number };
  d1Writes: { used: number; limit: number };
  queueOps: { used: number; limit: number };
  /** True once any counter crosses the soft threshold and the governor engaged. */
  degraded: boolean;
}

export interface PerUserReport {
  migrationUserId: string;
  sourceEmail: string;
  targetUpn: string;
  workloads: Array<{
    workload: Workload;
    status: JobStatus;
    itemsSucceeded: number;
    itemsSkipped: number;
    itemsFailed: number;
    bytes: number;
    durationSec: number | null;
    deltaPasses: number;
  }>;
}

/* ------------------------------------------------------------------ *
 * Audit
 * ------------------------------------------------------------------ */

export type AuditAction =
  | 'sign_in'
  | 'sign_out'
  | 'tenant_connect'
  | 'tenant_disconnect'
  | 'tenant_test'
  | 'secret_rotate'
  | 'user_select'
  | 'csv_import'
  | 'mapping_change'
  | 'provision'
  | 'password_csv_download'
  | 'job_start'
  | 'job_cancel'
  | 'job_retry'
  | 'config_change'
  | 'audit_export';

export interface AuditEntry {
  id: string;
  actorUpn: string;
  action: AuditAction;
  target: string | null;
  detail: string | null;
  createdAt: string; // ISO-8601 UTC
}
