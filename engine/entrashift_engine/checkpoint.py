"""Opaque resume state — build, persist, and re-apply after a VM reboot.

D1 is the source of truth for job state (SoW Phase 4): the ``jobs.checkpoint``
column stores an engine-defined JSON blob that lets a migration resume from the
last successful cursor after a reboot or crash. The control plane treats this
blob as opaque; only the engine interprets it.

``Checkpoint.cursor`` is a free-form dict whose shape is owned by each migrator:

    Exchange (exchange/migrator.py):
        {
          "folders_done":  ["<folderId>", ...],       # fully migrated folders
          "folder_map":    {"<srcFolderId>": "<dstFolderId>"},
          "item_deltas":   {"<srcFolderId>": "<deltaLink>"},  # for delta passes
          "current_folder": "<folderId>" | null
        }

    OneDrive (onedrive/migrator.py):
        {
          "delta_link":    "<opaque delta URL>" | null,  # for incremental passes
          "folder_map":    {"<srcItemId>": "<dstItemId>"},
          "items_done":    ["<srcItemId>", ...]
        }

The store rate-limits checkpoint writes to the configured interval so it never
breaches the D1 write budget.
"""

from __future__ import annotations

import time
from typing import Any, Optional

from pydantic import BaseModel, Field

from .contracts import CheckpointUpdate, Job, Workload
from .logging_setup import get_logger

log = get_logger("checkpoint")

CHECKPOINT_VERSION = 1


class Checkpoint(BaseModel):
    """Engine-defined resume state stored (as JSON) in ``jobs.checkpoint``."""

    version: int = CHECKPOINT_VERSION
    workload: Workload
    pass_: str = Field(default="full")
    cursor: dict[str, Any] = Field(default_factory=dict)
    progress_current: int = 0
    bytes_done: int = 0

    def to_json(self) -> dict[str, Any]:
        return self.model_dump()

    @classmethod
    def empty(cls, workload: Workload, pass_: str) -> "Checkpoint":
        return cls(workload=workload, pass_=pass_)


def load_checkpoint(job: Job, pass_: str) -> Checkpoint:
    """Reconstruct a :class:`Checkpoint` from a job fetched from the control plane.

    Called on start-up / resume. If the job carries no checkpoint (fresh job) or
    the stored version is incompatible, a fresh empty checkpoint is returned so
    the migration restarts cleanly rather than resuming from a bad cursor.
    """
    raw = job.checkpoint
    if not raw:
        return Checkpoint.empty(job.workload, pass_)
    try:
        cp = Checkpoint.model_validate(raw)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "checkpoint_parse_failed_restarting",
            extra={"job_id": job.id, "error": str(exc)},
        )
        return Checkpoint.empty(job.workload, pass_)
    if cp.version != CHECKPOINT_VERSION:
        log.warning(
            "checkpoint_version_mismatch_restarting",
            extra={"job_id": job.id, "found": cp.version, "want": CHECKPOINT_VERSION},
        )
        return Checkpoint.empty(job.workload, pass_)
    # A resumed delta checkpoint must match the pass being run.
    cp.pass_ = pass_
    return cp


class CheckpointStore:
    """Persists a checkpoint to the control plane, rate-limited to an interval.

    The migrator mutates ``store.checkpoint.cursor`` in place as it progresses
    and calls :meth:`maybe_flush` periodically; the store batches those into at
    most one D1 write per ``interval_sec``. :meth:`flush` forces a write (used
    at pass boundaries and on graceful shutdown).
    """

    def __init__(
        self,
        control_plane: Any,  # ControlPlaneClient (untyped to avoid a cycle)
        job_id: str,
        checkpoint: Checkpoint,
        interval_sec: int,
    ) -> None:
        self._cp = control_plane
        self._job_id = job_id
        self.checkpoint = checkpoint
        self._interval = interval_sec
        self._last_flush = 0.0

    def update(self, *, progress_current: int, bytes_done: int) -> None:
        """Record the latest cumulative counters onto the checkpoint."""
        self.checkpoint.progress_current = progress_current
        self.checkpoint.bytes_done = bytes_done

    async def maybe_flush(self) -> bool:
        """Flush if the interval has elapsed. Returns True if it wrote."""
        now = time.monotonic()
        if (now - self._last_flush) < self._interval:
            return False
        await self.flush()
        return True

    async def flush(self) -> None:
        """Persist the current checkpoint unconditionally."""
        update = CheckpointUpdate(
            checkpoint=self.checkpoint.to_json(),
            progress_current=self.checkpoint.progress_current,
            bytes_done=self.checkpoint.bytes_done,
        )
        await self._cp.checkpoint(self._job_id, update)
        self._last_flush = time.monotonic()


async def resume_job(control_plane: Any, job_id: str, pass_: str) -> tuple[Job, Checkpoint]:
    """Fetch a job from the control plane and rebuild its checkpoint.

    Used both on normal claim and on reboot recovery.
    """
    job = await control_plane.get_job(job_id)
    checkpoint = load_checkpoint(job, pass_)
    log.info(
        "job_resumed",
        extra={
            "job_id": job_id,
            "status": job.status.value,
            "pass": pass_,
            "progress_current": checkpoint.progress_current,
        },
    )
    return job, checkpoint
