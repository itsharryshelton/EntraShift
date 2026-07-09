"""Async client for the control-plane ``/api/vm/*`` API (see ``api-spec.md``).

Every request is authenticated with the Cloudflare Access **service token**
(``CF-Access-Client-Id`` / ``CF-Access-Client-Secret`` headers). The Worker
validates the resulting ``Cf-Access-Jwt-Assertion`` on each call.

Free-tier discipline (SoW §1.1) is enforced here as well as server-side:
    * ``update_progress`` keeps a per-job client-side floor so the engine never
      exceeds one progress write per job per ``minPollIntervalSec`` (default
      30 s). The Worker also rejects violations with 429 — this is belt & braces.
    * Item logs are batched by the caller and flushed via ``log_items``.
    * Nothing here ever touches Queues; job dispatch is the only Queue traffic.
"""

from __future__ import annotations

import asyncio
import time
from typing import Optional

import httpx

from .config import Settings
from .contracts import (
    CheckpointUpdate,
    EngineConfig,
    ItemLogBatch,
    ItemLogEntry,
    Job,
    ProgressUpdate,
    StatusUpdate,
    TenantRole,
    VmTokenRequest,
    VmTokenResponse,
)
from .logging_setup import get_logger
from .secrets import (
    SECRET_ACCESS_CLIENT_ID,
    SECRET_ACCESS_CLIENT_SECRET,
    SecretsProvider,
)

log = get_logger("control_plane")


class ControlPlaneError(Exception):
    """Raised when the control plane returns an unexpected status."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(f"[{status_code}] {code}: {message}")
        self.status_code = status_code
        self.code = code
        self.message = message


class ControlPlaneClient:
    """Authenticated client for the Worker VM API."""

    def __init__(self, settings: Settings, secrets: SecretsProvider) -> None:
        self._settings = settings
        self._secrets = secrets
        self._base = settings.control_plane_base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.http_timeout_sec)
        )
        self._access_headers: Optional[dict[str, str]] = None
        self._headers_lock = asyncio.Lock()
        # Client-side progress floor: job_id -> last monotonic write time.
        self._last_progress: dict[str, float] = {}
        self._min_poll_interval = float(settings.poll_interval_floor_sec)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "ControlPlaneClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    def set_min_poll_interval(self, seconds: float) -> None:
        """Adopt the server-reported floor (never below the local floor)."""
        self._min_poll_interval = max(
            float(self._settings.poll_interval_floor_sec), float(seconds)
        )

    # --- auth --------------------------------------------------------------

    async def _access(self) -> dict[str, str]:
        """Cloudflare Access service-token headers (loaded once from secrets)."""
        if self._access_headers is not None:
            return self._access_headers
        async with self._headers_lock:
            if self._access_headers is None:
                client_id = await self._secrets.get(SECRET_ACCESS_CLIENT_ID)
                client_secret = await self._secrets.get(SECRET_ACCESS_CLIENT_SECRET)
                self._access_headers = {
                    "CF-Access-Client-Id": client_id,
                    "CF-Access-Client-Secret": client_secret,
                }
            return self._access_headers

    async def _request(
        self, method: str, path: str, *, json_body: Optional[dict] = None
    ) -> httpx.Response:
        headers = dict(await self._access())
        headers["Content-Type"] = "application/json"
        resp = await self._client.request(
            method, f"{self._base}{path}", json=json_body, headers=headers
        )
        if resp.status_code == 429:
            # Server enforced its poll/write floor. Surface as a soft error the
            # caller can back off on; do not treat as a job failure.
            raise ControlPlaneError(429, "rate_limited", "control plane floor hit")
        if resp.status_code >= 400:
            code, message = _parse_error(resp)
            raise ControlPlaneError(resp.status_code, code, message)
        return resp

    # --- endpoints ---------------------------------------------------------

    async def get_config(self) -> EngineConfig:
        """GET /api/vm/config — dynamic engine configuration."""
        resp = await self._request("GET", "/api/vm/config")
        cfg = EngineConfig.model_validate(resp.json())
        # Keep the progress floor aligned with the server's declared minimum.
        self.set_min_poll_interval(cfg.min_poll_interval_sec)
        return cfg

    async def get_token(
        self, role: TenantRole, scope: Optional[str] = None
    ) -> VmTokenResponse:
        """POST /api/vm/token — short-lived Graph access token for a tenant.

        The client secret never leaves the Worker; we only receive the token.
        """
        body = VmTokenRequest(tenant_role=role, scope=scope).model_dump(
            by_alias=True, exclude_none=True
        )
        resp = await self._request("POST", "/api/vm/token", json_body=body)
        return VmTokenResponse.model_validate(resp.json())

    async def get_job(self, job_id: str) -> Job:
        """GET /api/vm/jobs/:id — current job state (for resume after reboot)."""
        resp = await self._request("GET", f"/api/vm/jobs/{job_id}")
        return Job.model_validate(resp.json())

    async def update_status(self, job_id: str, update: StatusUpdate) -> None:
        """POST /api/vm/jobs/:id/status — explicit transition / terminal state.

        Not rate-limited client-side: status transitions are infrequent and
        important (e.g. terminal failure). The server still governs budget.
        """
        await self._request(
            "POST",
            f"/api/vm/jobs/{job_id}/status",
            json_body=update.model_dump(by_alias=True, exclude_none=True),
        )
        log.info(
            "job_status_update",
            extra={"job_id": job_id, "status": update.status.value},
        )

    async def update_progress(
        self, job_id: str, update: ProgressUpdate, *, force: bool = False
    ) -> bool:
        """POST /api/vm/jobs/:id/progress — batched progress write.

        Enforces the client-side floor of one write per job per
        ``minPollIntervalSec``. Returns True if the write was sent, False if it
        was suppressed to respect the floor. Pass ``force=True`` only for a
        final flush at a terminal boundary.
        """
        now = time.monotonic()
        last = self._last_progress.get(job_id)
        if not force and last is not None and (now - last) < self._min_poll_interval:
            log.debug(
                "progress_suppressed_floor",
                extra={"job_id": job_id, "since_last_sec": round(now - last, 1)},
            )
            return False
        await self._request(
            "POST",
            f"/api/vm/jobs/{job_id}/progress",
            json_body=update.model_dump(by_alias=True, exclude_none=True),
        )
        self._last_progress[job_id] = now
        return True

    async def checkpoint(self, job_id: str, update: CheckpointUpdate) -> None:
        """POST /api/vm/jobs/:id/checkpoint — durable resume point."""
        await self._request(
            "POST",
            f"/api/vm/jobs/{job_id}/checkpoint",
            json_body=update.model_dump(by_alias=True),
        )
        log.debug("checkpoint_written", extra={"job_id": job_id})

    async def log_items(self, job_id: str, items: list[ItemLogEntry]) -> int:
        """POST /api/vm/jobs/:id/items — batched item-level skip/fail records.

        Returns the number of rows the server reports inserted. No-op for an
        empty batch (avoids spending a Worker request / D1 write for nothing).
        """
        if not items:
            return 0
        batch = ItemLogBatch(items=items)
        resp = await self._request(
            "POST",
            f"/api/vm/jobs/{job_id}/items",
            json_body=batch.model_dump(by_alias=True, exclude_none=True),
        )
        try:
            return int(resp.json().get("inserted", len(items)))
        except Exception:  # noqa: BLE001
            return len(items)


def _parse_error(resp: httpx.Response) -> tuple[str, str]:
    """Extract ``(code, message)`` from the standard error envelope."""
    try:
        body = resp.json()
        err = body.get("error", {})
        if isinstance(err, dict):
            return err.get("code", "error"), err.get("message", resp.reason_phrase)
    except Exception:  # noqa: BLE001
        pass
    return "error", resp.reason_phrase or f"HTTP {resp.status_code}"
