"""Engine main loop — the persistent service that runs on the Azure VM.

Responsibilities:
    * Poll dynamic config (``GET /api/vm/config``) and respect ``paused`` (the
      free-tier budget governor idles the engine).
    * Pull one job at a time from Cloudflare Queues (HTTP pull) — the only Queue
      traffic in the whole system.
    * Resume from the last durable checkpoint (fetched from the control plane),
      so a reboot mid-migration continues rather than restarts.
    * Acquire short-lived Graph tokens from the Worker, dispatch to the Exchange
      or OneDrive migrator, stream batched progress, checkpoint periodically.
    * Set the correct terminal status (including the distinct failure statuses)
      and ack the queue message.
    * Shut down gracefully on SIGTERM: stop claiming new work, let the in-flight
      job reach a safe checkpoint, and leave its queue lease to expire so it is
      redelivered and resumed.

Free-tier discipline is enforced end-to-end: never poll faster than the config
floor, one progress write per job per interval, batched item logs, no state
through Queues.
"""

from __future__ import annotations

import asyncio
import contextlib
import signal

from .checkpoint import CheckpointStore, resume_job
from .config import Settings, get_settings
from .contracts import (
    TERMINAL_STATUSES,
    JobDispatchMessage,
    JobStatus,
    StatusUpdate,
    TenantRole,
    Workload,
)
from .control_plane import ControlPlaneClient, ControlPlaneError
from .exchange.migrator import ExchangeMigrator
from .graph.client import GraphClient
from .graph.errors import GraphError, ThrottledError
from .graph.throttle import ThrottleGovernor
from .job_context import JobContext
from .logging_setup import get_logger, setup_logging
from .onedrive.migrator import OneDriveMigrator
from .queue_consumer import PulledMessage, QueueConsumer
from .secrets import build_secrets_provider

log = get_logger("worker")

# Delay before a throttled/deferred job is redelivered by the queue.
_REQUEUE_DELAY_SEC = 300


class EngineWorker:
    """Owns the long-lived clients and the poll/dispatch loop."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._stop = asyncio.Event()
        self._secrets = build_secrets_provider(
            settings.secrets_provider,
            settings.key_vault_url or None,
            settings.secrets_cache_ttl_sec,
        )
        self._control = ControlPlaneClient(settings, self._secrets)
        self._queue = QueueConsumer(settings, self._secrets)
        self._governor: ThrottleGovernor | None = None
        self._graph: GraphClient | None = None

    # ---- lifecycle --------------------------------------------------------

    def request_stop(self) -> None:
        """Signal a graceful shutdown (idempotent)."""
        if not self._stop.is_set():
            log.info("shutdown_requested")
            self._stop.set()

    async def _startup(self) -> None:
        cfg = await self._control.get_config()
        self._governor = ThrottleGovernor(
            per_tenant=cfg.per_tenant_concurrency,
            per_mailbox=cfg.per_mailbox_concurrency,
        )
        self._graph = GraphClient(
            token_provider=self._control.get_token,
            governor=self._governor,
            timeout_sec=self._settings.http_timeout_sec,
            max_retries=self._settings.graph_max_retries,
            backoff_max_sec=self._settings.graph_backoff_max_sec,
        )
        log.info(
            "engine_started",
            extra={
                "control_plane": self._settings.control_plane_base_url,
                "per_tenant_concurrency": cfg.per_tenant_concurrency,
                "per_mailbox_concurrency": cfg.per_mailbox_concurrency,
                "paused": cfg.paused,
            },
        )

    async def _shutdown(self) -> None:
        if self._graph:
            await self._graph.aclose()
        await self._queue.aclose()
        await self._control.aclose()
        log.info("engine_stopped")

    # ---- main loop --------------------------------------------------------

    async def run(self) -> None:
        await self._startup()
        try:
            while not self._stop.is_set():
                try:
                    await self._tick()
                except ControlPlaneError as exc:
                    # Rate-limited or transient control-plane error — back off.
                    log.warning(
                        "control_plane_error",
                        extra={"code": exc.code, "status": exc.status_code},
                    )
                    await self._idle()
                except Exception as exc:  # noqa: BLE001 - loop must not die
                    log.error("worker_tick_failed", extra={"error": str(exc)})
                    await self._idle()
        finally:
            await self._shutdown()

    async def _tick(self) -> None:
        """One iteration: refresh config, honour pause, claim + run a job."""
        cfg = await self._control.get_config()
        if cfg.paused:
            log.info("engine_paused_by_governor")
            await self._idle()
            return

        pulled = await self._queue.pull()
        if not pulled:
            await self._idle()
            return

        for message in pulled:
            if self._stop.is_set():
                # Don't ack — let the lease expire so the job is redelivered.
                break
            await self._handle(message)

    async def _idle(self) -> None:
        """Sleep for the configured poll interval, interruptible by shutdown."""
        interval = max(
            self._settings.poll_interval_floor_sec,
            self._settings.config_refresh_sec,
        )
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._stop.wait(), timeout=interval)

    # ---- per-job handling -------------------------------------------------

    async def _handle(self, pulled: PulledMessage) -> None:
        dispatch = pulled.message
        assert self._graph is not None and self._governor is not None
        log.info(
            "job_claimed",
            extra={
                "job_id": dispatch.job_id,
                "workload": dispatch.workload.value,
                "pass": dispatch.pass_,
                "attempts": pulled.attempts,
            },
        )

        # Refresh dynamic config for this job (concurrency/limits may have moved).
        cfg = await self._control.get_config()

        try:
            job, checkpoint = await resume_job(
                self._control, dispatch.job_id, dispatch.pass_
            )
        except ControlPlaneError as exc:
            log.warning(
                "job_fetch_failed_requeue",
                extra={"job_id": dispatch.job_id, "code": exc.code},
            )
            await self._queue.retry(pulled.lease_id, _REQUEUE_DELAY_SEC)
            return

        # Stale dispatch: the job already reached a terminal state (or was
        # cancelled) — ack and move on without doing work.
        if job.status in TERMINAL_STATUSES or job.status == JobStatus.CANCELLED:
            log.info(
                "stale_dispatch_acked",
                extra={"job_id": job.id, "status": job.status.value},
            )
            await self._queue.ack([pulled.lease_id])
            return

        store = CheckpointStore(
            self._control,
            dispatch.job_id,
            checkpoint,
            interval_sec=self._settings.checkpoint_interval_sec,
        )
        ctx = JobContext(
            settings=self._settings,
            config=cfg,
            dispatch=dispatch,
            graph=self._graph,
            control_plane=self._control,
            governor=self._governor,
            store=store,
            stop_event=self._stop,
        )

        running = (
            JobStatus.DELTA_RUNNING if dispatch.pass_ == "delta" else JobStatus.RUNNING
        )
        try:
            # Warm token cache + learn tenant ids for governor accounting.
            source_tid = await self._graph.ensure_tenant_id(TenantRole.SOURCE)
            dest_tid = await self._graph.ensure_tenant_id(TenantRole.DESTINATION)

            await self._control.update_status(dispatch.job_id, StatusUpdate(status=running))

            final = await self._run_migrator(ctx, dispatch, source_tid, dest_tid)

            # Persist a final checkpoint + progress regardless of outcome.
            await store.flush()

            if ctx.cancelled:
                await self._control.update_status(
                    dispatch.job_id, StatusUpdate(status=JobStatus.CANCELLED)
                )
                await self._queue.ack([pulled.lease_id])
            elif self._stop.is_set() and final != JobStatus.COMPLETED:
                # Graceful shutdown mid-job: leave the lease to expire so the
                # job is redelivered and resumes from the checkpoint.
                log.info("job_deferred_on_shutdown", extra={"job_id": dispatch.job_id})
            else:
                await self._control.update_status(
                    dispatch.job_id, StatusUpdate(status=final)
                )
                await self._queue.ack([pulled.lease_id])
                log.info(
                    "job_completed",
                    extra={
                        "job_id": dispatch.job_id,
                        "status": final.value,
                        "items_succeeded": ctx.items_succeeded,
                    },
                )

        except ThrottledError as exc:
            # Graph retry budget exhausted — back the job off and let the queue
            # redeliver it later. Not a terminal failure.
            log.warning(
                "job_backing_off_requeue",
                extra={"job_id": dispatch.job_id, "retry_after": exc.retry_after},
            )
            with contextlib.suppress(Exception):
                await ctx.report_progress(
                    JobStatus.BACKING_OFF, phase_text="Backing off (Graph throttling)", force=True
                )
            await self._queue.retry(pulled.lease_id, _REQUEUE_DELAY_SEC)

        except GraphError as exc:
            # Maps to a distinct terminal failure status (auth_expired /
            # permission_revoked / quota_exceeded / failed).
            with contextlib.suppress(Exception):
                await ctx.flush_items()
                await store.flush()
            await self._control.update_status(
                dispatch.job_id,
                StatusUpdate(
                    status=exc.job_status,
                    error_class=exc.error_class,
                    error_detail=exc.detail,
                ),
            )
            await self._queue.ack([pulled.lease_id])
            log.error(
                "job_failed",
                extra={
                    "job_id": dispatch.job_id,
                    "status": exc.job_status.value,
                    "error_class": exc.error_class,
                },
            )

        except Exception as exc:  # noqa: BLE001
            with contextlib.suppress(Exception):
                await self._control.update_status(
                    dispatch.job_id,
                    StatusUpdate(
                        status=JobStatus.FAILED,
                        error_class="EngineError",
                        error_detail=str(exc)[:2000],
                    ),
                )
            await self._queue.ack([pulled.lease_id])
            log.error(
                "job_failed_unexpected",
                extra={"job_id": dispatch.job_id, "error": str(exc)},
            )

    async def _run_migrator(
        self,
        ctx: JobContext,
        dispatch: JobDispatchMessage,
        source_tid: str,
        dest_tid: str,
    ) -> JobStatus:
        """Dispatch to the workload migrator and return the terminal-ish status."""
        if dispatch.workload == Workload.EXCHANGE:
            return await ExchangeMigrator(ctx, source_tid, dest_tid).run()
        if dispatch.workload == Workload.ONEDRIVE:
            migrator = OneDriveMigrator(ctx, source_tid, dest_tid)
            try:
                return await migrator.run()
            finally:
                await migrator.aclose()
        raise GraphError(f"unsupported workload: {dispatch.workload}")


def _install_signal_handlers(worker: EngineWorker) -> None:
    """Wire SIGTERM/SIGINT to a graceful stop where the platform supports it."""
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, worker.request_stop)
        except NotImplementedError:
            # add_signal_handler is unavailable on Windows dev boxes; the
            # KeyboardInterrupt path in run_engine covers SIGINT there.
            signal.signal(sig, lambda *_: worker.request_stop())


async def run_engine() -> None:
    """Async entrypoint: configure logging, build the worker, run until stopped."""
    settings = get_settings()
    setup_logging(
        settings.log_dir,
        level=settings.log_level,
        max_bytes=settings.log_file_max_bytes,
        backup_count=settings.log_file_backup_count,
    )
    worker = EngineWorker(settings)
    _install_signal_handlers(worker)
    await worker.run()
