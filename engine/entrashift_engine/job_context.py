"""Per-job execution context shared by the workload migrators.

Bundles everything a migrator needs (Graph client, control-plane client,
throttle governor, dynamic config, the dispatch message, the checkpoint store)
and centralises the free-tier-critical write discipline:

    * ``report_progress`` -> at most one D1 progress write per job per
      ``minPollIntervalSec`` (enforced client-side in ``ControlPlaneClient``).
    * ``log_item`` -> item-level skip/fail records are buffered and flushed in
      batches (on size or on ``heartbeat``), never one HTTP call per item.
    * ``heartbeat`` -> the single periodic call a migrator makes to flush the
      item buffer and persist a checkpoint at the configured interval.

Keeping this here (rather than in ``worker.py``) lets both migrators import it
without a circular dependency on the worker loop.
"""

from __future__ import annotations

import asyncio
import time
from typing import Optional

from .checkpoint import CheckpointStore
from .config import Settings
from .contracts import (
    TERMINAL_STATUSES,
    EngineConfig,
    ItemLogEntry,
    ItemStatus,
    JobDispatchMessage,
    JobStatus,
    ProgressUpdate,
    TenantRole,
)
from .control_plane import ControlPlaneClient
from .graph.client import GraphClient
from .graph.throttle import ThrottleGovernor
from .logging_setup import get_logger

log = get_logger("job")


class JobContext:
    """Everything a migrator needs to run one job, plus write batching."""

    def __init__(
        self,
        *,
        settings: Settings,
        config: EngineConfig,
        dispatch: JobDispatchMessage,
        graph: GraphClient,
        control_plane: ControlPlaneClient,
        governor: ThrottleGovernor,
        store: CheckpointStore,
        stop_event: asyncio.Event,
    ) -> None:
        self.settings = settings
        self.config = config
        self.dispatch = dispatch
        self.graph = graph
        self.control_plane = control_plane
        self.governor = governor
        self.store = store
        self._stop = stop_event
        # Set when the control plane reports this job cancelled mid-flight.
        self.cancelled = False
        self._last_cancel_check = 0.0

        self.job_id = dispatch.job_id
        # v1 convention: read always from source tenant, write to destination.
        self.source_role = TenantRole.SOURCE
        self.dest_role = TenantRole.DESTINATION

        # Cumulative counters (authoritative for progress + checkpoint).
        self.progress_current = store.checkpoint.progress_current
        self.progress_total: Optional[int] = None
        self.bytes_done = store.checkpoint.bytes_done
        self.bytes_total: Optional[int] = None
        self.items_succeeded = 0

        self._item_buffer: list[ItemLogEntry] = []

    # --- lifecycle ---------------------------------------------------------

    @property
    def source_tenant(self) -> TenantRole:
        return self.source_role

    def should_stop(self) -> bool:
        """True when the migrator should stop early — either a graceful
        shutdown (SIGTERM) or a control-plane cancellation was observed."""
        return self._stop.is_set() or self.cancelled

    async def _maybe_check_cancel(self) -> None:
        """Poll the control plane for a cancellation, throttled to ~60 s.

        Cancellation is engineer-initiated (``POST /api/jobs/:id/cancel`` flips
        the D1 status). We check on a slow cadence so it never dominates the
        read budget. A GET is a D1 read (cheap; 5M/day) not a write.
        """
        now = time.monotonic()
        if (now - self._last_cancel_check) < 60.0:
            return
        self._last_cancel_check = now
        try:
            job = await self.control_plane.get_job(self.job_id)
        except Exception as exc:  # noqa: BLE001 - never let a poll fail the job
            log.debug("cancel_check_failed", extra={"job_id": self.job_id, "error": str(exc)})
            return
        if job.status in TERMINAL_STATUSES or job.status == JobStatus.CANCELLED:
            self.cancelled = True
            log.info("job_cancellation_observed", extra={"job_id": self.job_id})

    # --- progress ----------------------------------------------------------

    async def report_progress(
        self,
        status: JobStatus,
        *,
        phase_text: Optional[str] = None,
        delta_token: Optional[str] = None,
        force: bool = False,
    ) -> None:
        """Send a batched progress update (respecting the 30 s floor)."""
        update = ProgressUpdate(
            status=status,
            phase_text=phase_text,
            progress_current=self.progress_current,
            progress_total=self.progress_total,
            bytes_done=self.bytes_done,
            bytes_total=self.bytes_total,
            delta_token=delta_token,
        )
        await self.control_plane.update_progress(self.job_id, update, force=force)

    # --- item skip-and-log -------------------------------------------------

    def log_item(
        self,
        item_id: str,
        *,
        status: ItemStatus,
        error_class: str,
        error_detail: str,
        folder_path: Optional[str] = None,
    ) -> None:
        """Buffer an item-level skip/fail record (SoW Phase 4 skip-and-log).

        A failed item is recorded here and NEVER raised into the job flow, so a
        single bad item can never fail the whole mailbox/drive job.
        """
        self._item_buffer.append(
            ItemLogEntry(
                item_id=item_id,
                folder_path=folder_path,
                status=status,
                error_class=error_class,
                error_detail=error_detail[:2000],  # keep D1 rows bounded
            )
        )
        log.info(
            "item_skipped",
            extra={
                "job_id": self.job_id,
                "item_id": item_id,
                "status": status.value,
                "error_class": error_class,
                "folder_path": folder_path,
            },
        )
        if len(self._item_buffer) >= self.settings.item_log_flush_size:
            # Fire-and-forget flush would risk ordering issues; instead we mark
            # for flush on the next heartbeat. Callers heartbeat frequently.
            pass

    async def flush_items(self) -> None:
        """Flush the buffered item log to the control plane."""
        if not self._item_buffer:
            return
        batch = self._item_buffer
        self._item_buffer = []
        await self.control_plane.log_items(self.job_id, batch)

    # --- periodic heartbeat ------------------------------------------------

    async def heartbeat(
        self, status: JobStatus, *, phase_text: Optional[str] = None
    ) -> None:
        """Periodic maintenance: persist checkpoint, flush items, report progress.

        Migrators call this frequently; the rate limiters inside ensure it maps
        to at most one checkpoint write and one progress write per interval.
        """
        self.store.update(
            progress_current=self.progress_current, bytes_done=self.bytes_done
        )
        await self.store.maybe_flush()
        if len(self._item_buffer) >= self.settings.item_log_flush_size:
            await self.flush_items()
        await self._maybe_check_cancel()
        await self.report_progress(status, phase_text=phase_text)
