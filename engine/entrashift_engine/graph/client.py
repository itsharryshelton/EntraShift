"""GraphClient — the single choke point for all Microsoft Graph HTTP calls.

Responsibilities (SoW Phase 4):
    * Inject a bearer token fetched from the control plane (``/api/vm/token``)
      and cache it per tenant role until shortly before expiry. The engine never
      holds a long-lived tenant secret — only these short-lived Graph tokens,
      and only in memory.
    * A central ``request()`` that HONORS ``Retry-After`` on **every** 429/503
      without exception, with exponential backoff + full jitter otherwise.
    * Feed every outcome to the ``ThrottleGovernor`` so it can self-reduce
      concurrency before sustained throttling.
    * Raise typed errors (``AuthExpired`` / ``PermissionRevoked`` /
      ``QuotaExceeded`` / ``ThrottledError`` / ``GraphError``) mapped to the
      distinct job failure statuses.

Preauthenticated URLs (Exchange ``importUrl``, OneDrive upload-session
``uploadUrl``) MUST be called *without* an ``Authorization`` header — use
``request(..., authenticated=False)`` for those.
"""

from __future__ import annotations

import asyncio
import email.utils
import random
import time
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

import httpx

from ..contracts import TenantRole, VmTokenResponse
from ..logging_setup import get_logger
from .errors import ThrottledError, classify_graph_error
from .throttle import ThrottleGovernor

log = get_logger("graph")

GRAPH_BASE = "https://graph.microsoft.com/v1.0"

# Refresh a token this many seconds before its stated expiry.
_TOKEN_SKEW_SEC = 120

# Token provider: given a tenant role, return a fresh VmTokenResponse.
TokenProvider = Callable[[TenantRole], Awaitable[VmTokenResponse]]


class _CachedToken:
    __slots__ = ("access_token", "tenant_id", "expires_epoch")

    def __init__(self, access_token: str, tenant_id: str, expires_epoch: float) -> None:
        self.access_token = access_token
        self.tenant_id = tenant_id
        self.expires_epoch = expires_epoch

    def valid(self) -> bool:
        return time.time() < (self.expires_epoch - _TOKEN_SKEW_SEC)


def _parse_iso8601(value: str) -> float:
    """Parse an ISO-8601 UTC timestamp to an epoch float."""
    v = value.replace("Z", "+00:00")
    return datetime.fromisoformat(v).timestamp()


def _parse_retry_after(header: Optional[str]) -> Optional[float]:
    """Interpret a ``Retry-After`` header (delta-seconds or HTTP-date)."""
    if not header:
        return None
    header = header.strip()
    try:
        return max(0.0, float(header))
    except ValueError:
        pass
    # Fall back to HTTP-date. On Python 3.10+ parsedate_to_datetime RAISES
    # ValueError/TypeError on unparseable input (older versions returned None);
    # either way an undecodable header must degrade to None (→ use backoff),
    # never crash the request loop.
    try:
        parsed = email.utils.parsedate_to_datetime(header)
    except (ValueError, TypeError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(0.0, (parsed - datetime.now(timezone.utc)).total_seconds())


class GraphClient:
    """Async Graph client with token caching, throttle handling, typed errors."""

    def __init__(
        self,
        token_provider: TokenProvider,
        governor: ThrottleGovernor,
        *,
        timeout_sec: float = 120.0,
        max_retries: int = 8,
        backoff_max_sec: float = 300.0,
        base_url: str = GRAPH_BASE,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._token_provider = token_provider
        self._governor = governor
        self._base_url = base_url.rstrip("/")
        self._max_retries = max_retries
        self._backoff_max = backoff_max_sec
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_sec),
            # Connection pooling; concurrency is bounded by the governor, not here.
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
            # Graph's /drive/items/{id}/content endpoint 302-redirects to a
            # short-lived download URL; follow redirects so that (and any other
            # Graph redirect) resolves transparently through this choke point.
            follow_redirects=True,
            # `transport` is an injection seam for tests (httpx.MockTransport).
            transport=transport,
        )
        self._tokens: dict[TenantRole, _CachedToken] = {}
        self._token_locks: dict[TenantRole, asyncio.Lock] = {
            TenantRole.SOURCE: asyncio.Lock(),
            TenantRole.DESTINATION: asyncio.Lock(),
        }

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "GraphClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    # --- token management --------------------------------------------------

    async def _bearer(self, role: TenantRole) -> tuple[str, str]:
        """Return ``(access_token, tenant_id)`` for a role, refreshing if stale."""
        cached = self._tokens.get(role)
        if cached and cached.valid():
            return cached.access_token, cached.tenant_id

        async with self._token_locks[role]:
            # Re-check inside the lock (another coroutine may have refreshed).
            cached = self._tokens.get(role)
            if cached and cached.valid():
                return cached.access_token, cached.tenant_id
            token = await self._token_provider(role)
            fresh = _CachedToken(
                access_token=token.access_token,
                tenant_id=token.tenant_id,
                expires_epoch=_parse_iso8601(token.expires_at),
            )
            self._tokens[role] = fresh
            log.info(
                "graph_token_acquired",
                extra={"tenant_role": role.value, "tenant_id": token.tenant_id},
            )
            return fresh.access_token, fresh.tenant_id

    def invalidate_token(self, role: TenantRole) -> None:
        """Drop a cached token (e.g. after a 401) to force a refresh."""
        self._tokens.pop(role, None)

    async def ensure_tenant_id(self, role: TenantRole) -> str:
        """Return the Entra tenant GUID for a role (fetching a token if needed).

        Used by the worker to construct migrators with the correct per-tenant
        identifiers for governor accounting.
        """
        _, tenant_id = await self._bearer(role)
        return tenant_id

    # --- core request ------------------------------------------------------

    async def request(
        self,
        method: str,
        url: str,
        *,
        role: Optional[TenantRole] = None,
        tenant_id: Optional[str] = None,
        authenticated: bool = True,
        json_body: Any = None,
        content: bytes | None = None,
        headers: Optional[dict[str, str]] = None,
        expected: tuple[int, ...] = (200, 201, 202, 204),
    ) -> httpx.Response:
        """Perform a Graph request with retries, Retry-After, and typed errors.

        ``url`` may be an absolute URL (preauthenticated import/upload URLs) or a
        path relative to the Graph base. When ``authenticated`` is True a role
        must be supplied so a bearer token can be attached.
        """
        full_url = url if url.startswith("http") else f"{self._base_url}{url}"
        # Tenant key for governor accounting — falls back to the URL host so we
        # still get *some* isolation when tenant_id is unknown.
        gov_tenant = tenant_id or (role.value if role else "unknown")

        attempt = 0
        while True:
            req_headers = dict(headers or {})
            if authenticated:
                if role is None:
                    raise ValueError("authenticated request requires a tenant role")
                token, tid = await self._bearer(role)
                req_headers["Authorization"] = f"Bearer {token}"
                gov_tenant = tenant_id or tid

            try:
                resp = await self._client.request(
                    method,
                    full_url,
                    json=json_body,
                    content=content,
                    headers=req_headers,
                )
            except httpx.TransportError as exc:
                # Network-level failure — retry with backoff, count as a soft
                # throttle signal so the governor eases off on flaky links.
                await self._governor.record(gov_tenant, throttled=True)
                if attempt >= self._max_retries:
                    raise ThrottledError(
                        f"transport error after {attempt} retries: {exc}",
                        detail=str(exc),
                    ) from exc
                await self._sleep_backoff(attempt, None)
                attempt += 1
                continue

            # ---- throttling: honor Retry-After on EVERY 429/503 -------------
            if resp.status_code in (429, 503):
                await self._governor.record(gov_tenant, throttled=True)
                retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
                if attempt >= self._max_retries:
                    raise ThrottledError(
                        f"throttled ({resp.status_code}) after {attempt} retries",
                        retry_after=retry_after,
                        status_code=resp.status_code,
                        detail=_safe_body(resp),
                    )
                log.warning(
                    "graph_retry_after",
                    extra={
                        "status": resp.status_code,
                        "retry_after_sec": retry_after,
                        "attempt": attempt,
                        "tenant": gov_tenant,
                    },
                )
                await self._sleep_backoff(attempt, retry_after)
                attempt += 1
                continue

            # ---- success ----------------------------------------------------
            if resp.status_code in expected:
                await self._governor.record(gov_tenant, throttled=False)
                return resp

            # ---- other errors: map to typed error --------------------------
            await self._governor.record(gov_tenant, throttled=False)
            code, message = _parse_graph_error(resp)
            err = classify_graph_error(
                resp.status_code, code, message, _safe_body(resp)
            )
            # A 401 might be a genuinely expired cached token; drop it so the
            # next job attempt re-fetches. We still raise so the caller decides.
            if resp.status_code == 401 and role is not None:
                self.invalidate_token(role)
            raise err

    async def _sleep_backoff(self, attempt: int, retry_after: Optional[float]) -> None:
        """Sleep for Retry-After if present, else exponential backoff + jitter."""
        if retry_after is not None:
            # Retry-After is authoritative; add a little jitter to avoid a
            # thundering herd when many jobs are throttled together.
            delay = retry_after + random.uniform(0, 1.0)
        else:
            base = min(self._backoff_max, (2 ** attempt))
            delay = random.uniform(0, base)  # full jitter
        await asyncio.sleep(min(delay, self._backoff_max))

    # --- convenience helpers ----------------------------------------------

    async def get_json(
        self, path: str, *, role: TenantRole, tenant_id: Optional[str] = None
    ) -> dict[str, Any]:
        resp = await self.request("GET", path, role=role, tenant_id=tenant_id)
        return resp.json()

    async def paged(
        self, path: str, *, role: TenantRole, tenant_id: Optional[str] = None
    ) -> AsyncIterator[list[dict[str, Any]]]:
        """Async-iterate an OData collection, following ``@odata.nextLink``.

        Yields each page's ``value`` list. The caller flattens. Handy for folder
        and delta enumeration.
        """
        next_url: Optional[str] = path
        while next_url:
            resp = await self.request("GET", next_url, role=role, tenant_id=tenant_id)
            data = resp.json()
            yield data.get("value", [])
            next_url = data.get("@odata.nextLink")


def _parse_graph_error(resp: httpx.Response) -> tuple[Optional[str], str]:
    """Extract ``(code, message)`` from a Graph error body, defensively."""
    try:
        body = resp.json()
        err = body.get("error", {})
        if isinstance(err, dict):
            return err.get("code"), err.get("message", resp.reason_phrase)
    except Exception:  # noqa: BLE001 - body may be empty/non-JSON
        pass
    return None, resp.reason_phrase or f"HTTP {resp.status_code}"


def _safe_body(resp: httpx.Response) -> str:
    """Short, log-safe snippet of an error body (never item content)."""
    try:
        text = resp.text
    except Exception:  # noqa: BLE001
        return ""
    return text[:500]
