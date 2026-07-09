"""Wire contract — Python mirror of ``shared/contracts.ts``.

This module is the single Python source of truth for the job/status/workload
shapes and the request/response bodies exchanged with the Cloudflare Worker
control plane. It MUST stay byte-for-byte compatible with ``shared/contracts.ts``
and ``shared/api-spec.md``.

Wire format rule: the control plane speaks **camelCase** JSON. We keep idiomatic
snake_case attribute names in Python and map them to camelCase on the wire using
pydantic v2 aliases (``alias_generator=to_camel`` + ``populate_by_name=True``).

    * Parse inbound JSON:  ``Model.model_validate(json_dict)``
    * Serialise outbound:  ``model.model_dump(by_alias=True, exclude_none=True)``

Any change here is a breaking change to the wire protocol — keep all three
files (this, contracts.ts, api-spec.md) in sync.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# --------------------------------------------------------------------------- #
# Enums (mirror the TS string-literal unions)
# --------------------------------------------------------------------------- #


class TenantRole(str, Enum):
    """Which side of the migration a tenant sits on."""

    SOURCE = "source"
    DESTINATION = "destination"


class Workload(str, Enum):
    """Migration workloads. v1 covers Exchange Online and OneDrive only."""

    EXCHANGE = "exchange"
    ONEDRIVE = "onedrive"


WORKLOADS: list[Workload] = [Workload.EXCHANGE, Workload.ONEDRIVE]


class JobStatus(str, Enum):
    """Job lifecycle status. A "job" is one user + one workload.

    The distinct terminal-failure states (``AUTH_EXPIRED``,
    ``PERMISSION_REVOKED``, ``QUOTA_EXCEEDED``) surface in the UI with
    remediation hints (SoW Phase 4, Error Reporting).
    """

    QUEUED = "queued"
    PROVISIONING = "provisioning"
    RUNNING = "running"
    BACKING_OFF = "backing_off"
    DELTA_PENDING = "delta_pending"
    DELTA_RUNNING = "delta_running"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    PAUSED = "paused"
    # ---- distinct failure states (remediation hints in UI) ----
    AUTH_EXPIRED = "auth_expired"
    PERMISSION_REVOKED = "permission_revoked"
    QUOTA_EXCEEDED = "quota_exceeded"
    FAILED = "failed"


TERMINAL_STATUSES: frozenset[JobStatus] = frozenset(
    {
        JobStatus.COMPLETED,
        JobStatus.CANCELLED,
        JobStatus.AUTH_EXPIRED,
        JobStatus.PERMISSION_REVOKED,
        JobStatus.QUOTA_EXCEEDED,
        JobStatus.FAILED,
    }
)


class ItemStatus(str, Enum):
    """Per-item outcome for the skip-and-log record.

    Item-level failures never fail the whole job (SoW Phase 4).
    """

    SKIPPED = "skipped"
    FAILED = "failed"


class MappingStatus(str, Enum):
    """Mapping state of a discovered/imported user before jobs are queued."""

    UNMAPPED = "unmapped"
    MAPPED = "mapped"
    AUTO_CREATE = "auto_create"
    PROVISIONED = "provisioned"
    INVALID = "invalid"


# --------------------------------------------------------------------------- #
# Base model — camelCase on the wire, snake_case in Python
# --------------------------------------------------------------------------- #


class _WireModel(BaseModel):
    """Base for every wire model.

    * ``alias_generator=to_camel`` maps ``progress_current`` <-> ``progressCurrent``.
    * ``populate_by_name`` lets us construct with either the snake_case field
      name or the camelCase alias (useful in tests / internal construction).
    * ``extra="ignore"`` makes inbound parsing forward-compatible: the control
      plane may add fields we do not yet model without breaking the engine.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )


# --------------------------------------------------------------------------- #
# Core records
# --------------------------------------------------------------------------- #


class Job(_WireModel):
    """Full job record as returned by ``GET /api/vm/jobs/:id`` (for resume)."""

    id: str
    migration_user_id: str
    source_email: str
    target_upn: str
    workload: Workload
    status: JobStatus
    phase_text: Optional[str] = None
    progress_current: int = 0
    progress_total: Optional[int] = None
    bytes_done: int = 0
    bytes_total: Optional[int] = None
    delta_token: Optional[str] = None
    attempts: int = 0
    error_class: Optional[str] = None
    error_detail: Optional[str] = None
    created_at: str
    updated_at: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    # Opaque engine-defined resume state. Present in the D1 `jobs.checkpoint`
    # column; the control plane returns it verbatim so the engine can resume.
    checkpoint: Optional[dict[str, Any]] = None


# --------------------------------------------------------------------------- #
# Queue message (Worker -> Queues -> VM). ONE small message per user+workload.
# --------------------------------------------------------------------------- #


class JobDispatchMessage(_WireModel):
    """The only thing that flows through Cloudflare Queues.

    Kept tiny — Queue ops are metered per 64 KB and capped at 10k/day. All
    progress/state flows through D1, never back through Queues.
    """

    job_id: str
    migration_user_id: str
    workload: Workload
    source_email: str
    target_upn: str
    include_archive: bool = False
    # 'full' | 'delta' — the engine requests the delta token from the control
    # plane. `pass` is a Python keyword, so the attribute is `pass_` with the
    # `pass` wire alias set explicitly (overrides the camel alias generator).
    pass_: str = Field(default="full", alias="pass")
    # Monotonic dispatch counter for idempotency / stale-message detection.
    dispatch_seq: int = 0


# --------------------------------------------------------------------------- #
# VM <-> control-plane API bodies
# --------------------------------------------------------------------------- #


class VmTokenRequest(_WireModel):
    """POST /api/vm/token — request a short-lived Graph access token."""

    tenant_role: TenantRole
    # Always the app-only default. Defaulted here so callers rarely set it.
    scope: Optional[str] = "https://graph.microsoft.com/.default"


class VmTokenResponse(_WireModel):
    """Response to POST /api/vm/token. Token is short-lived; never persisted."""

    access_token: str
    expires_at: str  # ISO-8601 UTC
    tenant_id: str


class ProgressUpdate(_WireModel):
    """POST /api/vm/jobs/:id/progress — batched progress update.

    The engine MUST NOT call this more than once per job per 30 s (D1 write
    budget). The Worker enforces the floor server-side and returns 429.
    """

    status: JobStatus
    phase_text: Optional[str] = None
    progress_current: Optional[int] = None
    progress_total: Optional[int] = None
    bytes_done: Optional[int] = None
    bytes_total: Optional[int] = None
    # Persist the delta token when a pass completes so incremental passes resume.
    delta_token: Optional[str] = None


class CheckpointUpdate(_WireModel):
    """POST /api/vm/jobs/:id/checkpoint — durable resume point (survives reboot)."""

    # Opaque, engine-defined resume state (last folder/item cursor).
    checkpoint: dict[str, Any]
    progress_current: int
    bytes_done: int


class StatusUpdate(_WireModel):
    """POST /api/vm/jobs/:id/status — explicit status transition."""

    status: JobStatus
    error_class: Optional[str] = None
    error_detail: Optional[str] = None


class ItemLogEntry(_WireModel):
    """A single item-level skip/fail record."""

    item_id: str
    folder_path: Optional[str] = None
    status: ItemStatus
    error_class: str
    error_detail: str


class ItemLogBatch(_WireModel):
    """POST /api/vm/jobs/:id/items — batched item-level skip/fail log."""

    items: list[ItemLogEntry]


class EngineConfig(_WireModel):
    """GET /api/vm/config — engine runtime configuration (from D1 `config`)."""

    min_poll_interval_sec: int = 30
    per_mailbox_concurrency: int = 2
    per_tenant_concurrency: int = 4
    exchange_export_batch_size: int = 20
    onedrive_upload_session_threshold_bytes: int = 4_194_304
    item_max_retries: int = 5
    # True when the budget governor has paused non-essential work — engine idles.
    paused: bool = False
