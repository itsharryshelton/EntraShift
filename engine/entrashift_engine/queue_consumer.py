"""Cloudflare Queues HTTP **pull** consumer (SoW §1.1 / api-spec.md).

The VM pulls job-dispatch messages **directly** from the Cloudflare Queues HTTP
pull API — not through the Worker — using a Cloudflare API token scoped to
*queue consume only* (from the secrets provider). This keeps job dispatch off
the Worker request budget entirely.

Queues carries dispatch **only**: one tiny ``JobDispatchMessage`` per
user+workload. All progress/state flows back through D1 via the control plane,
never through Queues (10k ops/day free-tier cap).

Pull/ack semantics:
    * ``pull`` leases up to ``batch_size`` messages for ``visibility_timeout``.
    * A successfully-processed message is ``ack``-ed (deleted).
    * A message whose job should be retried later is released with a delay via
      the same ack endpoint's ``retries`` array (re-appears after the delay).
    * If neither ack nor retry is sent, the lease simply expires and the message
      is redelivered — the safe default on a hard crash.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Any

import httpx

from .config import Settings
from .contracts import JobDispatchMessage
from .logging_setup import get_logger
from .secrets import SECRET_QUEUE_API_TOKEN, SecretsProvider

log = get_logger("queue")

_CF_API = "https://api.cloudflare.com/client/v4"


@dataclass(slots=True)
class PulledMessage:
    """A leased queue message plus the job payload it carries."""

    lease_id: str
    attempts: int
    message: JobDispatchMessage


class QueueConsumer:
    """HTTP pull consumer for the ``entrashift-jobs`` queue."""

    def __init__(self, settings: Settings, secrets: SecretsProvider) -> None:
        self._settings = settings
        self._secrets = secrets
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.http_timeout_sec)
        )
        self._pull_url = (
            f"{_CF_API}/accounts/{settings.cf_account_id}"
            f"/queues/{settings.cf_queue_id}/messages/pull"
        )
        self._ack_url = (
            f"{_CF_API}/accounts/{settings.cf_account_id}"
            f"/queues/{settings.cf_queue_id}/messages/ack"
        )
        self._token: str | None = None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "QueueConsumer":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def _auth(self) -> dict[str, str]:
        if self._token is None:
            self._token = await self._secrets.get(SECRET_QUEUE_API_TOKEN)
        return {"Authorization": f"Bearer {self._token}"}

    async def pull(self) -> list[PulledMessage]:
        """Lease up to ``queue_pull_batch_size`` messages. Empty list if none."""
        body = {
            "visibility_timeout_ms": self._settings.queue_visibility_timeout_sec * 1000,
            "batch_size": self._settings.queue_pull_batch_size,
        }
        resp = await self._client.post(
            self._pull_url, json=body, headers=await self._auth()
        )
        resp.raise_for_status()
        payload = resp.json()
        if not payload.get("success", False):
            log.warning("queue_pull_unsuccessful", extra={"errors": payload.get("errors")})
            return []

        pulled: list[PulledMessage] = []
        for raw in payload.get("result", {}).get("messages", []):
            try:
                dispatch = _decode_message_body(raw.get("body"))
                pulled.append(
                    PulledMessage(
                        lease_id=raw["lease_id"],
                        attempts=int(raw.get("attempts", 1)),
                        message=JobDispatchMessage.model_validate(dispatch),
                    )
                )
            except Exception as exc:  # noqa: BLE001
                # Poison message: log and let the lease expire so it is not lost
                # silently. It will redeliver; a persistently bad message should
                # be surfaced by the control plane's stale-dispatch detection.
                log.error(
                    "queue_message_decode_failed",
                    extra={"lease_id": raw.get("lease_id"), "error": str(exc)},
                )
        return pulled

    async def ack(self, lease_ids: list[str]) -> None:
        """Delete successfully-processed messages."""
        if not lease_ids:
            return
        await self._ack_retry(acks=[{"lease_id": lid} for lid in lease_ids], retries=[])

    async def retry(self, lease_id: str, delay_seconds: int = 0) -> None:
        """Release a message back to the queue, optionally after a delay."""
        await self._ack_retry(
            acks=[],
            retries=[{"lease_id": lease_id, "delay_seconds": max(0, delay_seconds)}],
        )

    async def _ack_retry(
        self, *, acks: list[dict[str, Any]], retries: list[dict[str, Any]]
    ) -> None:
        resp = await self._client.post(
            self._ack_url,
            json={"acks": acks, "retries": retries},
            headers=await self._auth(),
        )
        resp.raise_for_status()


def _decode_message_body(body: Any) -> dict[str, Any]:
    """Normalise a pulled message body into a dict.

    Cloudflare may return the body as a JSON object, a JSON string, or a
    base64-encoded string depending on how the producer serialised it. Handle
    all three so we interoperate with the Worker regardless of content-type.
    """
    if isinstance(body, dict):
        return body
    if isinstance(body, str):
        # Try plain JSON first.
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                return parsed
        except (ValueError, TypeError):
            pass
        # Fall back to base64-wrapped JSON.
        try:
            decoded = base64.b64decode(body, validate=True)
            parsed = json.loads(decoded)
            if isinstance(parsed, dict):
                return parsed
        except (ValueError, TypeError, binascii.Error) as exc:
            raise ValueError(f"unrecognised message body encoding: {exc}") from exc
    raise ValueError(f"unsupported message body type: {type(body).__name__}")
